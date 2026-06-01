/**
 * Mockup Compositor — Phase H
 * Downloads a transparent design PNG and a blank shirt photo,
 * resizes the design to fit the print zone, and composites them.
 * Karpathy: one function, no class hierarchy, no speculative abstractions.
 */
import sharp from "sharp";
import { generateImage } from "./_core/imageGeneration";

export interface PrintZone {
  x: number;      // ratio 0-1 (left offset)
  y: number;      // ratio 0-1 (top offset)
  width: number;  // ratio 0-1
  height: number; // ratio 0-1
}

export interface CompositeConfig {
  designUrl: string;   // Transparent PNG from S3
  mockupUrl: string;   // Blank shirt photo from S3
  printZone: PrintZone;
}

/** Default print zone — centered chest area for a standard t-shirt blank.
 * Sized to match real DTG print areas (~14" x 16" on a standard tee).
 * Reference: Etsy best-seller mockups typically fill 75-90% of the visible chest.
 */
export const DEFAULT_PRINT_ZONE: PrintZone = {
  x: 0.22,
  y: 0.15,
  width: 0.56,
  height: 0.60,
};

async function downloadImage(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download image: ${url} (${res.status})`);
  const arrayBuf = await res.arrayBuffer();
  return Buffer.from(arrayBuf);
}

/**
 * Remove background from a design image.
 * Strategy:
 * 1. First try simple white-pixel removal (works when AI follows the white-bg prompt)
 * 2. If the image appears to be a full mockup (shirt on background), use AI edit mode
 *    to extract just the graphic design.
 */
export async function removeBackground(imageBuf: Buffer): Promise<Buffer> {
  try {
    // Analyze the image to determine if it's already transparent, on white, or a full mockup
    const { data, info } = await sharp(imageBuf)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const { width, height, channels } = info;
    const edgeSize = 20; // Check 20px border
    const THRESHOLD = 235;

    let whiteEdgePixels = 0;
    let transparentEdgePixels = 0;
    let totalEdgePixels = 0;

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (x < edgeSize || x >= width - edgeSize || y < edgeSize || y >= height - edgeSize) {
          const idx = (y * width + x) * channels;
          const r = data[idx];
          const g = data[idx + 1];
          const b = data[idx + 2];
          const a = data[idx + 3];
          totalEdgePixels++;
          if (a < 30) {
            transparentEdgePixels++;
          } else if (r > THRESHOLD && g > THRESHOLD && b > THRESHOLD) {
            whiteEdgePixels++;
          }
        }
      }
    }

    const transparentEdgeRatio = transparentEdgePixels / totalEdgePixels;
    const whiteEdgeRatio = whiteEdgePixels / totalEdgePixels;
    console.log(`[BG Removal] Transparent edge ratio: ${(transparentEdgeRatio * 100).toFixed(1)}%, White edge ratio: ${(whiteEdgeRatio * 100).toFixed(1)}%`);

    if (transparentEdgeRatio > 0.3) {
      // Already transparent — skip removal entirely
      return imageBuf;
    } else if (whiteEdgeRatio > 0.3) {
      // Near-white or pure-white background (typical output from AI image generators
      // following the DTF prompt). Use flood-fill removal — it's fast, preserves
      // interior white design elements, and avoids the AI extraction round-trip.
      // Threshold 220 catches near-white (r≈235) as well as pure white (r=255).
      const { data, info } = await sharp(imageBuf)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      return simpleWhiteRemoval(data, info);
    } else {
      // Colored/textured background (legacy shirt mockup images).
      // Use AI extraction to isolate the design from the shirt.
      return await aiDesignExtraction(imageBuf);
    }
  } catch (err) {
    console.warn("[BG Removal] Failed, using original image:", err);
    return imageBuf;
  }
}

/**
 * Crop an image to the bounding box of its colored (non-white, non-transparent) content.
 * Used after AI extraction to remove the white padding the AI adds around designs.
 * White pixels inside the design (paddle face, net interior) are preserved because
 * we only crop the CANVAS — we don't modify any pixel values.
 */
async function cropToColoredContent(imageBuf: Buffer): Promise<Buffer> {
  try {
    const { data, info } = await sharp(imageBuf)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const { width, height, channels } = info;

    // Find bounding box of non-transparent pixels
    let minX = width, maxX = 0, minY = height, maxY = 0;
    let found = false;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = (y * width + x) * channels;
        const a = data[idx + 3];
        if (a > 30) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
          found = true;
        }
      }
    }

    if (!found) return imageBuf; // Fully transparent — return as-is

    // Add 4px padding so we don't clip anti-aliased edges
    const pad = 4;
    const left = Math.max(0, minX - pad);
    const top = Math.max(0, minY - pad);
    const cropW = Math.min(width - left, maxX - left + 1 + pad);
    const cropH = Math.min(height - top, maxY - top + 1 + pad);

    // Only crop if it actually reduces the canvas meaningfully (> 5% reduction)
    const reduction = 1 - (cropW * cropH) / (width * height);
    if (reduction < 0.05) return imageBuf;

    return sharp(imageBuf)
      .extract({ left, top, width: cropW, height: cropH })
      .toBuffer();
  } catch {
    return imageBuf;
  }
}

/**
 * Edge-connected flood-fill white removal.
 * Only removes white pixels that are reachable from the image border.
 * This preserves white elements INSIDE the design (e.g., white net fills, white text).
 * Threshold 220 catches near-white backgrounds (r≈235) that AI image generators
 * produce instead of pure white (r=255).
 */
function simpleWhiteRemoval(data: Buffer, info: { width: number; height: number; channels: number }): Promise<Buffer> {
  const { width, height, channels } = info;
  const THRESHOLD = 220;

  const output = Buffer.from(data);
  const visited = new Uint8Array(width * height);
  const queue: number[] = [];

  // Seed the flood fill from all edge pixels that are white
  const isWhite = (idx: number) => {
    return output[idx] > THRESHOLD && output[idx + 1] > THRESHOLD && output[idx + 2] > THRESHOLD;
  };

  for (let x = 0; x < width; x++) {
    const topIdx = (0 * width + x) * channels;
    const botIdx = ((height - 1) * width + x) * channels;
    if (isWhite(topIdx) && !visited[x]) { visited[x] = 1; queue.push(x); }
    const botPx = (height - 1) * width + x;
    if (isWhite(botIdx) && !visited[botPx]) { visited[botPx] = 1; queue.push(botPx); }
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
    // Make transparent
    const idx = px * channels;
    output[idx + 3] = 0;

    // Check 4 neighbors
    const neighbors = [
      px - 1, px + 1,
      px - width, px + width,
    ];
    for (const n of neighbors) {
      const ny = Math.floor(n / width);
      const nx = n % width;
      if (n < 0 || n >= width * height) continue;
      if (Math.abs(ny - py) > 1 && Math.abs(nx - px_x) > 1) continue; // wrap guard
      if (visited[n]) continue;
      if (isWhite(n * channels)) {
        visited[n] = 1;
        queue.push(n);
      }
    }
  }

  return sharp(output, { raw: { width, height, channels: channels as 4 } })
    .png()
    .toBuffer();
}

/**
 * AI-powered design extraction for images that show a design on a shirt/colored background.
 * Uses the image generation edit mode to isolate just the graphic design.
 */
async function aiDesignExtraction(imageBuf: Buffer): Promise<Buffer> {
  try {
    const b64 = imageBuf.toString("base64");
    const result = await generateImage({
      prompt: "Extract ONLY the graphic design/artwork from this t-shirt image. Remove the t-shirt, remove any background (wooden planks, fabric texture, etc). Output ONLY the isolated graphic design elements (text, illustrations, badges, icons) on a pure white background. The design should be centered with white space around it. No shirt, no background, no shadows — just the flat graphic artwork.",
      originalImages: [{
        b64Json: b64,
        mimeType: "image/png",
      }],
    });

    if (!result.url) {
      console.warn("[AI Extraction] No URL returned, falling back to original");
      return imageBuf;
    }

    // Download the extracted design
    const res = await fetch(result.url);
    if (!res.ok) throw new Error(`Failed to download extracted design: ${res.status}`);
    const extractedBuf = Buffer.from(await res.arrayBuffer());

    // Apply simple white removal on the extracted design (which should be on white bg)
    const { data, info } = await sharp(extractedBuf)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const noBg = await simpleWhiteRemoval(data, info);

    // Crop to the bounding box of non-transparent content.
    // The AI often returns a larger canvas with the design not centered — crop removes
    // the excess transparent area so the design fills its bounding box correctly.
    return cropToColoredContent(noBg);
  } catch (err) {
    console.warn("[AI Extraction] Failed, falling back to simple removal:", err);
    // Fall back to simple removal
    const { data, info } = await sharp(imageBuf)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    return simpleWhiteRemoval(data, info);
  }
}

/**
 * Trim transparent pixels from a design image to get the actual content bounds.
 * This ensures the design fills the print zone properly without excess whitespace.
 */
async function trimDesign(designBuf: Buffer): Promise<Buffer> {
  try {
    // Trim transparent/near-transparent edges
    const trimmed = await sharp(designBuf)
      .trim({ threshold: 10 })
      .toBuffer();
    return trimmed;
  } catch {
    // If trim fails (e.g., entirely transparent), return original
    return designBuf;
  }
}

/**
 * Smart content trim: handles both white-background and transparent designs.
 * For white-background images: uses Sharp's native trim with white background color.
 * For transparent images: uses Sharp's native trim on alpha channel.
 * NEVER removes white pixels from inside the design content.
 */
async function trimToContent(imageBuf: Buffer): Promise<Buffer> {
  try {
    const { data, info } = await sharp(imageBuf)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const { width, height, channels } = info;
    const edgeSize = 20;
    const THRESHOLD = 240;

    // Check if edges are transparent
    let transparentEdge = 0;
    let totalEdge = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (x < edgeSize || x >= width - edgeSize || y < edgeSize || y >= height - edgeSize) {
          const a = data[(y * width + x) * channels + 3];
          totalEdge++;
          if (a < 30) transparentEdge++;
        }
      }
    }

    const isTransparent = transparentEdge / totalEdge > 0.3;

    if (isTransparent) {
      // Already transparent background — trim transparent edges
      return sharp(imageBuf).trim({ threshold: 10 }).toBuffer();
    } else {
      // White background — trim using Sharp's background-aware trim
      // This trims the uniform white border WITHOUT touching interior white pixels
      return sharp(imageBuf)
        .trim({ background: { r: 255, g: 255, b: 255 }, threshold: 30 })
        .toBuffer();
    }
  } catch {
    return imageBuf;
  }
}

/**
 * Composite a transparent design onto a mockup blank within the specified print zone.
 * Returns a PNG buffer of the final composite.
 *
 * Scaling strategy:
 * 1. Detect design background type (transparent, white, or full mockup)
 * 2. Trim to content bounds using Sharp's native trim (background-color aware)
 * 3. Scale trimmed design to fill the print zone (contain, aspect-ratio preserved)
 * 4. Center the design within the print zone
 */
export async function compositeDesignOnMockup(config: CompositeConfig): Promise<Buffer> {
  // 1. Download both images
  const [rawDesignBuf, mockupBuf] = await Promise.all([
    downloadImage(config.designUrl),
    downloadImage(config.mockupUrl),
  ]);

  // 1b. Check if the design is already transparent (production-ready).
  // If so, skip background removal entirely — just trim to content bounds.
  // If not transparent, run the full removal pipeline.
  const { data: edgeData, info: edgeInfo } = await sharp(rawDesignBuf)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width: ew, height: eh, channels: ec } = edgeInfo;
  const edgeSz = 20;
  let transEdge = 0, totalEdge = 0;
  for (let y = 0; y < eh; y++) {
    for (let x = 0; x < ew; x++) {
      if (x < edgeSz || x >= ew - edgeSz || y < edgeSz || y >= eh - edgeSz) {
        totalEdge++;
        if (edgeData[(y * ew + x) * ec + 3] < 30) transEdge++;
      }
    }
  }
  const isAlreadyTransparent = transEdge / totalEdge > 0.3;
  console.log(`[Compositor] Design transparent: ${isAlreadyTransparent} (${(transEdge/totalEdge*100).toFixed(1)}% transparent edges)`);

  let trimmedDesign: Buffer;
  if (isAlreadyTransparent) {
    // Production-ready transparent PNG — just trim to content bounds
    trimmedDesign = await trimDesign(rawDesignBuf);
  } else {
    // Raw image with background — run full removal pipeline
    const trimmedFirst = await trimToContent(rawDesignBuf);
    const noBgDesign = await removeBackground(trimmedFirst);
    trimmedDesign = await trimDesign(noBgDesign);
  }

  // 2. Get mockup dimensions
  const mockupMeta = await sharp(mockupBuf).metadata();
  const mockupW = mockupMeta.width!;
  const mockupH = mockupMeta.height!;

  // 3. Calculate print zone in pixels
  const zoneX = Math.round(config.printZone.x * mockupW);
  const zoneY = Math.round(config.printZone.y * mockupH);
  const zoneW = Math.round(config.printZone.width * mockupW);
  const zoneH = Math.round(config.printZone.height * mockupH);

  // 4. Get design dimensions after trim
  const designMeta = await sharp(trimmedDesign).metadata();
  const designW = designMeta.width!;
  const designH = designMeta.height!;

  // 5. Scale design to FILL the print zone WIDTH.
  // The user drew the zone — the design should fill its width edge-to-edge.
  // Anchor to TOP-CENTER (not center-center) — this matches real DTF placement
  // where designs sit at the top of the print area, not floating in the middle.
  const scaleByWidth = zoneW / designW;
  const scaleByHeight = zoneH / designH;
  // Prefer width-fill. Only use height if the scaled design would overflow the zone.
  const scale = Math.min(scaleByWidth, scaleByHeight);
  let finalW = Math.round(designW * scale);
  let finalH = Math.round(designH * scale);

  const resizedDesign = await sharp(trimmedDesign)
    .resize(finalW, finalH, { fit: "fill", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .toBuffer();

  // 6. Position design: horizontally centered, vertically anchored to TOP of print zone
  const offsetX = zoneX + Math.round((zoneW - finalW) / 2);
  const offsetY = zoneY; // TOP anchor — not centered vertically

  // 7. Composite design onto mockup, output as WebP (compressed, max 1000x1000)
  const composite = sharp(mockupBuf)
    .composite([{ input: resizedDesign, left: offsetX, top: offsetY }]);

  // Resize to max 1000x1000 if larger
  const compositeW = mockupW;
  const compositeH = mockupH;
  if (compositeW > 1000 || compositeH > 1000) {
    composite.resize(1000, 1000, { fit: "inside", withoutEnlargement: true });
  }

  // Output as compressed WebP for Shopify
  const result = await composite
    .webp({ quality: 82, effort: 4 })
    .toBuffer();

  return result;
}
