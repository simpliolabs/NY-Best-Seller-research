/**
 * Production Image Processor — v2 (Magenta Chromakey)
 *
 * Converts a raw generated design image into a production-ready transparent PNG.
 *
 * Architecture (spike-validated 5/5):
 * 1. Generate a STANDALONE version of the design on a solid magenta background
 *    using gpt-image-2 in GENERATE mode (not edit mode). The source image is
 *    passed as a style reference, not as the canvas being edited.
 * 2. Corner-sampled flood-fill chromakey: sample the corner pixel color, then
 *    edge-connected flood-fill removing all pixels within tolerance of that color.
 *    This produces a clean transparent PNG with no halos.
 * 3. Crop to content bounds and upload to S3.
 *
 * Why magenta: the model reliably produces a flat colored background when asked.
 * It does NOT produce exact #FF00FF — it produces a muted pink/magenta (r≈200-220,
 * g≈60-100, b≈120-170). The corner-sampled flood-fill handles this variance
 * automatically because it keys off the ACTUAL corner color, not a hardcoded value.
 *
 * Why NOT edit mode: edit mode treats the source as a canvas and draws ON it.
 * Generate mode with a style reference produces a new standalone artwork that
 * matches the style without inheriting the background/garment from the source.
 */
import sharp from "sharp";
import { storagePut } from "./storage";
import { updateConceptProductionUrl } from "./db";
import { chromakeyFromCorners } from "./chromakey";

/**
 * Generate a standalone design on magenta background using gpt-image-2 generate mode.
 * The source image is passed as a style reference (image[]) — NOT as the edit canvas.
 * Returns the raw PNG buffer from the API.
 */
async function generateStandaloneDesign(
  sourceImageUrl: string,
  promptDescription: string
): Promise<Buffer> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not configured");

  // Download source image to send as style reference
  const imgResp = await fetch(sourceImageUrl);
  if (!imgResp.ok) throw new Error(`Failed to download source image: ${imgResp.status}`);
  const imgBuf = Buffer.from(await imgResp.arrayBuffer());

  // Build the prompt: standalone artwork on solid magenta background
  const prompt = [
    `Create a standalone t-shirt graphic design artwork.`,
    `Subject and style: ${promptDescription}`,
    `BACKGROUND: Solid hot pink/magenta (#FF00FF) background filling the entire canvas.`,
    `The artwork must have a hard, clean edge against the magenta background — no blending, no gradient, no soft edges.`,
    `Use ONLY the colors described in the style within the artwork itself. The magenta is ONLY for the background.`,
    `PRINT-SAFE: render any net, mesh, fence, grid, screen, lattice, rope or repeating-line element as SOLID FULL-COLOR shapes, never thin open mesh with gaps; no hairline/thin strokes — every line must be a thick filled shape so it survives DTF printing and the chroma-key.`,
    `The artwork's own colors must stay clearly away from magenta/hot-pink/fuchsia so no part of the design keys out with the background. Avoid tiny unreadable text and fine smooth gradients.`,
    `NO shirt, NO garment, NO fabric texture visible. Just the flat 2D artwork on solid magenta.`,
    `The design should be centered and fill approximately 60-70% of the canvas.`,
  ].join(" ");

  console.log(`[ProdProcessor v2] Generating standalone design. Prompt: "${prompt.substring(0, 120)}..."`);

  // images/edits endpoint (the only one that accepts image[]) with the source as style reference
  const formData = new FormData();
  formData.append("model", "gpt-image-2");
  formData.append("prompt", prompt);
  formData.append("size", "1024x1024");
  formData.append("quality", "medium"); // was "high" — halve cost/latency of this 2nd call (audit #2); matches the first-pass gen
  // Pass source image as style reference
  const blob = new Blob([imgBuf], { type: "image/png" });
  formData.append("image[]", blob, "style_reference.png");

  const resp = await fetch("https://api.openai.com/v1/images/edits", {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}` },
    body: formData,
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`gpt-image-2 API error (${resp.status}): ${errText.substring(0, 300)}`);
  }

  const data = await resp.json() as { data: Array<{ b64_json?: string; url?: string }> };
  const item = data.data?.[0];
  if (!item) throw new Error("gpt-image-2 returned no image data");

  if (item.b64_json) {
    return Buffer.from(item.b64_json, "base64");
  } else if (item.url) {
    const dlResp = await fetch(item.url);
    if (!dlResp.ok) throw new Error(`Failed to download generated image: ${dlResp.status}`);
    return Buffer.from(await dlResp.arrayBuffer());
  }
  throw new Error("gpt-image-2 response has neither b64_json nor url");
}

/**
 * Crop to bounding box of non-transparent content.
 * Removes the transparent padding left after chromakey.
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
    if (reduction < 0.05) return imageBuf;

    return sharp(imageBuf)
      .extract({ left, top, width: cropW, height: cropH })
      .toBuffer();
  } catch {
    return imageBuf;
  }
}

/**
 * Process a raw design image URL into a production-ready transparent PNG.
 *
 * Pipeline:
 * 1. Generate standalone artwork on magenta BG (gpt-image-2 generate mode)
 * 2. Chromakey: corner-sampled flood-fill → transparent
 * 3. Crop to content bounds
 * 4. Upload to S3
 * 5. Persist URL in DB
 *
 * @param imageUrl - URL of the raw generated design image (used as style reference)
 * @param conceptId - DB concept ID
 * @param variation - A/B/C variation key
 * @param promptDescription - Text description of the design (from imagePromptA/B/C or style+conceptName)
 * @returns URL of the production-ready transparent PNG in S3
 */
export async function processDesignForProduction(
  imageUrl: string,
  conceptId: number,
  variation: "A" | "B" | "C",
  promptDescription?: string,
  isManual = false,
): Promise<string> {
  console.log(`[ProdProcessor v2] Processing concept ${conceptId} variation ${variation}...`);

  // Check if the source image is already transparent (skip regeneration)
  const srcResp = await fetch(imageUrl);
  if (!srcResp.ok) throw new Error(`Failed to download source image: ${imageUrl} (${srcResp.status})`);
  const srcBuf = Buffer.from(await srcResp.arrayBuffer());

  const { data, info } = await sharp(srcBuf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
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

  let transparentPng: Buffer;
  if (transparentRatio > 0.3) {
    // Already transparent — just crop to content bounds
    console.log(`[ProdProcessor v2] Image already transparent (${(transparentRatio * 100).toFixed(1)}%), cropping only`);
    transparentPng = await cropToContent(srcBuf);
  } else if (isManual) {
    // Manual upload (PO 2026-06-15 bug #1): a FINISHED user design on a literal background. Remove the
    // bg LOCALLY (white → flood-fill, colored → AI-extraction fallback) — NEVER regenerate via
    // gpt-image-2, which replaces the user's own art and throws without OPENAI_API_KEY (the upload errors).
    console.log(`[ProdProcessor v2] Manual upload — local background removal, no AI regeneration`);
    const { removeBackground } = await import("./mockupCompositor");
    const removed = await removeBackground(srcBuf);
    transparentPng = await cropToContent(removed);
  } else {
    // Generate standalone design on magenta BG, then chromakey
    const description = promptDescription || "the design shown in the reference image";
    const rawMagenta = await generateStandaloneDesign(imageUrl, description);
    const keyed = await chromakeyFromCorners(rawMagenta);
    transparentPng = await cropToContent(keyed);
  }

  // Upload to S3
  const fileKey = `production/${conceptId}-${variation}-${Date.now()}.png`;
  const { url } = await storagePut(fileKey, transparentPng, "image/png");

  // Save to DB
  await updateConceptProductionUrl(conceptId, variation, url);

  console.log(`[ProdProcessor v2] Done: concept ${conceptId} variation ${variation} → ${url}`);
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
  imagePromptA?: string | null;
  imagePromptB?: string | null;
  imagePromptC?: string | null;
  conceptName?: string;
  style?: string;
}): Promise<{ processed: number; skipped: number; failed: number }> {
  let processed = 0, skipped = 0, failed = 0;

  const variations: Array<{
    key: "A" | "B" | "C";
    imageUrl: string | null | undefined;
    productionUrl: string | null | undefined;
    prompt: string | null | undefined;
  }> = [
    { key: "A", imageUrl: concept.imageUrlA, productionUrl: concept.productionUrlA, prompt: concept.imagePromptA },
    { key: "B", imageUrl: concept.imageUrlB, productionUrl: concept.productionUrlB, prompt: concept.imagePromptB },
    { key: "C", imageUrl: concept.imageUrlC, productionUrl: concept.productionUrlC, prompt: concept.imagePromptC },
  ];

  for (const v of variations) {
    if (!v.imageUrl) { skipped++; continue; }
    if (v.productionUrl) { skipped++; continue; } // Already processed

    try {
      // Build a description from the prompt or concept metadata
      const description = v.prompt
        || `${concept.conceptName || "design"} in ${concept.style || "graphic tee"} style`;
      await processDesignForProduction(v.imageUrl, concept.id, v.key, description);
      processed++;
    } catch (err) {
      console.error(`[ProdProcessor v2] Failed concept ${concept.id} variation ${v.key}:`, err);
      failed++;
    }
  }

  return { processed, skipped, failed };
}
