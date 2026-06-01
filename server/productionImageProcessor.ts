/**
 * Production Image Processor
 * 
 * Converts a raw generated design image (white/near-white background) into a
 * production-ready transparent PNG and uploads it to S3.
 * 
 * Strategy: Use AI extraction to isolate the design from its background.
 * The AI reliably produces clean designs on white backgrounds. We then apply
 * simpleWhiteRemoval (threshold=240 for pure white) to make the background
 * transparent. The result is stored in productionUrl* columns.
 * 
 * This runs ONCE per image (at generation time or via backfill), so the
 * compositor can composite directly without any background removal at render time.
 */
import sharp from "sharp";
import { generateImage } from "./_core/imageGeneration";
import { storagePut } from "./storage";
import { updateConceptProductionUrl } from "./db";

/**
 * Edge-connected flood-fill white removal.
 * Only removes white pixels reachable from the image border.
 * Preserves interior white elements (paddle face, net interior, white text).
 * Uses threshold=240 (pure white only) to avoid corrupting near-white design elements.
 */
async function removeWhiteBackground(imageBuf: Buffer): Promise<Buffer> {
  const { data, info } = await sharp(imageBuf)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height, channels } = info;
  const THRESHOLD = 240; // Pure white only — safe for interior white elements
  const output = Buffer.from(data);
  const visited = new Uint8Array(width * height);
  const queue: number[] = [];

  const isWhite = (idx: number) =>
    output[idx] > THRESHOLD && output[idx + 1] > THRESHOLD && output[idx + 2] > THRESHOLD;

  // Seed from all edge pixels that are pure white
  for (let x = 0; x < width; x++) {
    const topPx = x;
    const botPx = (height - 1) * width + x;
    if (isWhite(topPx * channels) && !visited[topPx]) { visited[topPx] = 1; queue.push(topPx); }
    if (isWhite(botPx * channels) && !visited[botPx]) { visited[botPx] = 1; queue.push(botPx); }
  }
  for (let y = 1; y < height - 1; y++) {
    const leftPx = y * width;
    const rightPx = y * width + (width - 1);
    if (isWhite(leftPx * channels) && !visited[leftPx]) { visited[leftPx] = 1; queue.push(leftPx); }
    if (isWhite(rightPx * channels) && !visited[rightPx]) { visited[rightPx] = 1; queue.push(rightPx); }
  }

  // BFS flood fill
  while (queue.length > 0) {
    const px = queue.pop()!;
    const py = Math.floor(px / width);
    const px_x = px % width;
    output[px * channels + 3] = 0; // transparent

    for (const n of [px - 1, px + 1, px - width, px + width]) {
      if (n < 0 || n >= width * height) continue;
      const ny = Math.floor(n / width);
      const nx = n % width;
      if (Math.abs(ny - py) > 1 || Math.abs(nx - px_x) > 1) continue; // wrap guard
      if (visited[n]) continue;
      if (isWhite(n * channels)) {
        visited[n] = 1;
        queue.push(n);
      }
    }
  }

  return sharp(output, { raw: { width, height, channels: channels as 4 } }).png().toBuffer();
}

/**
 * Crop to bounding box of non-transparent content.
 * Removes transparent padding added by AI extraction.
 */
async function cropToContent(imageBuf: Buffer): Promise<Buffer> {
  try {
    const { data, info } = await sharp(imageBuf)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const { width, height, channels } = info;

    let minX = width, maxX = 0, minY = height, maxY = 0;
    let found = false;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const a = data[(y * width + x) * channels + 3];
        if (a > 30) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
          found = true;
        }
      }
    }

    if (!found) return imageBuf;

    const pad = 4;
    const left = Math.max(0, minX - pad);
    const top = Math.max(0, minY - pad);
    const cropW = Math.min(width - left, maxX - left + 1 + pad * 2);
    const cropH = Math.min(height - top, maxY - top + 1 + pad * 2);

    const reduction = 1 - (cropW * cropH) / (width * height);
    if (reduction < 0.05) return imageBuf; // Not worth cropping

    return sharp(imageBuf)
      .extract({ left, top, width: cropW, height: cropH })
      .toBuffer();
  } catch {
    return imageBuf;
  }
}

/**
 * Use AI to extract the design from its background.
 * The AI reliably isolates graphic design elements and places them on a pure white background.
 * We then apply flood-fill white removal to get a transparent PNG.
 */
async function aiExtractDesign(imageBuf: Buffer): Promise<Buffer> {
  const b64 = imageBuf.toString("base64");
  const result = await generateImage({
    prompt: [
      "Extract ONLY the graphic design/artwork from this image.",
      "Remove ALL background — whether it is white, near-white, colored, or a shirt/garment.",
      "Output ONLY the isolated graphic design elements (text, illustrations, icons, badges) on a PURE WHITE (#FFFFFF) background.",
      "The design should be centered with white space around it.",
      "No shirt, no fabric, no shadows, no gradients — just the flat 2D graphic artwork on pure white.",
    ].join(" "),
    originalImages: [{ b64Json: b64, mimeType: "image/png" }],
  });

  if (!result.url) throw new Error("AI extraction returned no URL");

  const res = await fetch(result.url);
  if (!res.ok) throw new Error(`Failed to download extracted design: ${res.status}`);
  const extractedBuf = Buffer.from(await res.arrayBuffer());

  // Remove pure white background from the AI result
  const noBg = await removeWhiteBackground(extractedBuf);

  // Crop to content bounds (AI may add padding around the design)
  return cropToContent(noBg);
}

/**
 * Process a raw design image URL into a production-ready transparent PNG.
 * Downloads the image, extracts the design via AI, removes background, and uploads to S3.
 * 
 * @param imageUrl - URL of the raw generated design image
 * @param conceptId - DB concept ID for logging
 * @param variation - A/B/C variation key
 * @returns URL of the production-ready transparent PNG in S3
 */
export async function processDesignForProduction(
  imageUrl: string,
  conceptId: number,
  variation: "A" | "B" | "C"
): Promise<string> {
  console.log(`[ProdProcessor] Processing concept ${conceptId} variation ${variation}...`);

  // Download the raw image
  const res = await fetch(imageUrl);
  if (!res.ok) throw new Error(`Failed to download image: ${imageUrl} (${res.status})`);
  const rawBuf = Buffer.from(await res.arrayBuffer());

  // Check if already transparent (skip AI extraction)
  const { data, info } = await sharp(rawBuf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const edgeSize = 20;
  let transparentEdgePixels = 0, totalEdgePixels = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (x < edgeSize || x >= width - edgeSize || y < edgeSize || y >= height - edgeSize) {
        const a = data[(y * width + x) * channels + 3];
        totalEdgePixels++;
        if (a < 30) transparentEdgePixels++;
      }
    }
  }
  const transparentRatio = transparentEdgePixels / totalEdgePixels;
  console.log(`[ProdProcessor] Transparent edge ratio: ${(transparentRatio * 100).toFixed(1)}%`);

  let transparentPng: Buffer;
  if (transparentRatio > 0.3) {
    // Already transparent — just crop to content bounds
    console.log(`[ProdProcessor] Image already transparent, cropping to content bounds`);
    transparentPng = await cropToContent(rawBuf);
  } else {
    // Use AI extraction to get clean transparent design
    console.log(`[ProdProcessor] Running AI extraction...`);
    transparentPng = await aiExtractDesign(rawBuf);
  }

  // Upload to S3
  const fileKey = `production/${conceptId}-${variation}-${Date.now()}.png`;
  const { url } = await storagePut(fileKey, transparentPng, "image/png");

  // Save to DB
  await updateConceptProductionUrl(conceptId, variation, url);

  console.log(`[ProdProcessor] Done: concept ${conceptId} variation ${variation} → ${url}`);
  return url;
}

/**
 * Process all missing production images for a concept.
 * Skips variations that already have a productionUrl.
 */
export async function processConceptProductionImages(concept: {
  id: number;
  imageUrlA?: string | null;
  imageUrlB?: string | null;
  imageUrlC?: string | null;
  productionUrlA?: string | null;
  productionUrlB?: string | null;
  productionUrlC?: string | null;
}): Promise<{ processed: number; skipped: number; failed: number }> {
  let processed = 0, skipped = 0, failed = 0;

  const variations: Array<{ key: "A" | "B" | "C"; imageUrl: string | null | undefined; productionUrl: string | null | undefined }> = [
    { key: "A", imageUrl: concept.imageUrlA, productionUrl: concept.productionUrlA },
    { key: "B", imageUrl: concept.imageUrlB, productionUrl: concept.productionUrlB },
    { key: "C", imageUrl: concept.imageUrlC, productionUrl: concept.productionUrlC },
  ];

  for (const v of variations) {
    if (!v.imageUrl) { skipped++; continue; }
    if (v.productionUrl) { skipped++; continue; } // Already processed

    try {
      await processDesignForProduction(v.imageUrl, concept.id, v.key);
      processed++;
    } catch (err) {
      console.error(`[ProdProcessor] Failed concept ${concept.id} variation ${v.key}:`, err);
      failed++;
    }
  }

  return { processed, skipped, failed };
}
