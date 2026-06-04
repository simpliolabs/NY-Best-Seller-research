/**
 * Pattern Production Processor — v3 (Magenta Chromakey)
 *
 * Two-step pipeline for trend_patterns:
 * 1. generateStandaloneDesign — gpt-image-2 /edits with solid magenta background.
 *    The source image is passed as a style reference (image[]), NOT as the edit canvas.
 *    The model generates a NEW standalone artwork on a flat magenta background.
 * 2. chromakeyFromCorners — corner-sampled flood-fill removes the magenta background,
 *    producing a clean transparent PNG with no halos.
 * 3. cropToContent — trims transparent padding.
 * 4. assertTransparentPng — validates the result before upload (throws on opaque output).
 * 5. storagePut → productionDesignUrl (canonical transparent asset).
 * 6. compositeDesignOnMockup → previewImageUrl (shirt thumbnail).
 *
 * Why magenta background (not transparent):
 * gpt-image-1 background:"transparent" is unreliable — it fails consistently on dark-shirt
 * source images (heather navy, dark grey) because the model sees no distinct background
 * region to make transparent. gpt-image-2 + magenta BG is deterministic: we inject a
 * known-color background, then remove it programmatically via chromakey. The chromakey
 * keys off the ACTUAL corner color (not hardcoded #FF00FF) to handle the model's muted
 * pink/magenta variance (r≈200-220, g≈60-100, b≈120-170).
 *
 * Why gpt-image-2 (not gpt-image-1):
 * gpt-image-1 does not reliably honor the magenta background instruction — it sometimes
 * ignores it and returns a white or shirt-colored background. gpt-image-2 reliably
 * produces a flat colored background when instructed. Spike-validated 5/5.
 */
import sharp from "sharp";
import { storagePut } from "./storage";
import {
  getProductGroupsByWorkspace,
  getMockupsByGroup,
} from "./productGroupDb";
import {
  compositeDesignOnMockup,
  DEFAULT_PRINT_AREA,
} from "./mockupCompositor";
import { getGarmentBbox, resolveZoneToPhoto } from "./garmentDetector";
import {
  updateTrendPatternImage,
  updateTrendPatternProductionUrl,
} from "./nicheHunterDb";
import { chromakeyFromCorners } from "./chromakey";

// ─── Artwork extraction ─────────────────────────────────────────────────────────

/**
 * Extract the artwork/print area from a shirt product photo.
 * Etsy source images are typically shirt flat-lays (~2000x2000px).
 * The print area is in the center of the image.
 * Cropping prevents gpt-image-2 from treating the shirt as part of the subject.
 *
 * Crop region: 25% from each side, 25% from top, 50% height.
 * This eliminates shirt necklines, collars, and labels on all flat-lay styles.
 */
async function extractArtworkArea(imgBuf: Buffer): Promise<Buffer> {
  const metadata = await sharp(imgBuf).metadata();
  const w = metadata.width ?? 1000;
  const h = metadata.height ?? 1000;

  const left = Math.round(w * 0.25);
  const top = Math.round(h * 0.25);
  const cropWidth = Math.round(w * 0.50);
  const cropHeight = Math.round(h * 0.50);

  console.log(`[PatternProd] extractArtworkArea: ${w}x${h} → crop(${left}, ${top}, ${cropWidth}, ${cropHeight})`);

  return sharp(imgBuf)
    .extract({ left, top, width: cropWidth, height: cropHeight })
    .png()
    .toBuffer();
}

// ─── Standalone design generation (Step 1) ────────────────────────────────────

/**
 * Generate a standalone design on a solid magenta background using gpt-image-2.
 * The source image is passed as a style reference (image[]) — NOT as the edit canvas.
 * Returns the raw PNG buffer from the API (magenta background, not yet transparent).
 *
 * The incoming promptDescription is the adaptedConcept or characterSwap edit instruction.
 * We wrap it with magenta-BG framing here so callers don't need to know the pipeline detail.
 */
async function generateStandaloneDesign(
  sourceImageUrl: string,
  promptDescription: string
): Promise<Buffer> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not configured");

  const imgResp = await fetch(sourceImageUrl);
  if (!imgResp.ok) throw new Error(`Failed to download source image: ${imgResp.status}`);
  const imgBuf = Buffer.from(await imgResp.arrayBuffer());

  // Pre-step: Extract artwork from product photo (shirt mockup).
  const imgPng = await extractArtworkArea(imgBuf);

  // Build the standalone generation prompt with magenta background instruction.
  // The promptDescription is the adapted concept / swap instruction from the caller.
  const prompt = [
    `Create a standalone t-shirt graphic design artwork.`,
    `Subject and style: ${promptDescription}`,
    `BACKGROUND: Solid hot pink/magenta (#FF00FF) background filling the entire canvas.`,
    `The artwork must have a hard, clean edge against the magenta background — no blending, no gradient, no soft edges.`,
    `Use ONLY the colors described in the style within the artwork itself. The magenta is ONLY for the background.`,
    `NO shirt, NO garment, NO fabric texture visible. Just the flat 2D artwork on solid magenta.`,
    `The design should be centered and fill approximately 60-70% of the canvas.`,
  ].join(" ");

  console.log(`[PatternProd] Generating standalone design (gpt-image-2, magenta BG). Prompt: "${prompt.substring(0, 120)}..."`);

  const formData = new FormData();
  formData.append("model", "gpt-image-2");
  formData.append("prompt", prompt);
  formData.append("size", "1024x1024");
  formData.append("quality", "high");
  // Pass source image as style reference (image[] — NOT the edit canvas)
  const blob = new Blob([new Uint8Array(imgPng)], { type: "image/png" });
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

// ─── Output validation ───────────────────────────────────────────────────────

/**
 * Assert that a PNG buffer has a transparent background.
 * Two checks must both pass:
 *   1. Corner pixels: all 4 corners must have alpha < 16 (nearly transparent)
 *   2. Transparent pixel ratio: ≥ 20% of pixels must have alpha < 128
 *
 * If either check fails, throws an error with the patternId for log tracing.
 * This is the final safety net — catches edge cases where the chromakey color
 * appears in the design itself (e.g., a magenta-heavy design that partially keys out).
 */
export async function assertTransparentPng(buf: Buffer, patternId: string): Promise<void> {
  const { data, info } = await sharp(buf)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;

  // Check 1: 4 corner pixels must all have alpha < 16
  const cornerCoords = [
    [0, 0],
    [width - 1, 0],
    [0, height - 1],
    [width - 1, height - 1],
  ] as const;

  for (const [cx, cy] of cornerCoords) {
    const alpha = data[(cy * width + cx) * channels + 3];
    if (alpha >= 16) {
      throw new Error(
        `[PatternProd] VALIDATION FAIL pattern=${patternId}: corner pixel (${cx},${cy}) has alpha=${alpha} (expected <16). Chromakey did not remove background. Aborting storagePut.`
      );
    }
  }

  // Check 2: transparent pixel ratio must be ≥ 20%
  let transparentCount = 0;
  const totalPixels = width * height;
  for (let i = 0; i < totalPixels; i++) {
    if (data[i * channels + 3] < 128) transparentCount++;
  }
  const ratio = transparentCount / totalPixels;
  if (ratio < 0.20) {
    throw new Error(
      `[PatternProd] VALIDATION FAIL pattern=${patternId}: transparent pixel ratio=${(ratio * 100).toFixed(1)}% (expected ≥20%). Chromakey did not remove enough background. Aborting storagePut.`
    );
  }

  // Check 3: design must have content — non-transparent pixels must be ≥ 5% of total
  // Catches blank or near-blank outputs (model returned empty canvas after chromakey).
  const opaqueCount = totalPixels - transparentCount;
  const opaqueRatio = opaqueCount / totalPixels;
  if (opaqueRatio < 0.05) {
    throw new Error(
      `[PatternProd] DESIGN_TOO_SPARSE pattern=${patternId}: non-transparent pixel ratio=${(opaqueRatio * 100).toFixed(1)}% (expected ≥5%). Design is blank or near-blank. Aborting storagePut.`
    );
  }

  console.log(`[PatternProd] assertTransparentPng PASS pattern=${patternId}: ratio=${(ratio * 100).toFixed(1)}% transparent, ${(opaqueRatio * 100).toFixed(1)}% design content`);
}

// ─── Default template selection ───────────────────────────────────────────────

/**
 * Get the first mockup template for a workspace (by createdAt ASC, then sortOrder ASC).
 * Returns null if no product group or templates exist for the workspace.
 */
async function getFirstWorkspaceTemplate(workspaceId: string) {
  const groups = await getProductGroupsByWorkspace(workspaceId);
  if (groups.length === 0) return null;

  const firstGroup = groups.sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  )[0];

  const templates = await getMockupsByGroup(firstGroup.id);
  if (templates.length === 0) return null;

  return { template: templates[0], group: firstGroup };
}

// ─── Main entry point ─────────────────────────────────────────────────────────

/**
 * Full production pipeline for a single trend pattern.
 *
 * Steps:
 * 1. gpt-image-2 /edits + magenta BG → raw magenta-background PNG
 * 2. chromakeyFromCorners → transparent PNG (programmatic, deterministic)
 * 3. cropToContent → trim transparent padding → productionDesignUrl candidate
 * 4. assertTransparentPng → validate before upload (throws on failure, no bad writes)
 * 5. storagePut + updateTrendPatternProductionUrl → productionDesignUrl
 * 6. compositeDesignOnMockup → previewImageUrl (shirt thumbnail)
 *
 * Writes both productionDesignUrl and previewImageUrl to DB.
 * Returns { productionDesignUrl, previewImageUrl }.
 */
export async function processPatternProduction(
  patternId: string,
  workspaceId: string,
  sourceImageUrl: string,
  promptDescription: string
): Promise<{ productionDesignUrl: string; previewImageUrl: string }> {
  console.log(`[PatternProd] Processing pattern ${patternId}...`);

  // Step 1: Generate standalone design on magenta background (gpt-image-2)
  const rawMagenta = await generateStandaloneDesign(sourceImageUrl, promptDescription);

  // Step 2: Chromakey — remove magenta background via corner-sampled flood-fill
  const keyed = await chromakeyFromCorners(rawMagenta);

  // Step 3: Crop to content bounding box
  const transparentPng = await cropToContent(keyed);

  // Step 4: Validate transparency before upload — throws if opaque (no silent bad writes)
  await assertTransparentPng(transparentPng, patternId);

  // Step 5: Upload transparent PNG as productionDesignUrl
  const prodKey = `pattern-production/${patternId}-${Date.now()}.png`;
  const { url: productionDesignUrl } = await storagePut(prodKey, transparentPng, "image/png");
  await updateTrendPatternProductionUrl(patternId, productionDesignUrl);
  console.log(`[PatternProd] productionDesignUrl: ${productionDesignUrl}`);

  // Step 6: Composite onto first workspace template for previewImageUrl
  let previewImageUrl: string;
  try {
    const result = await getFirstWorkspaceTemplate(workspaceId);
    if (result) {
      const { template, group } = result;
      const printAreaRelGarment = (group.printZone as { x: number; y: number; width: number; height: number } | null) ?? DEFAULT_PRINT_AREA;
      const garmentBbox = await getGarmentBbox(template.id, template.imageUrl);
      const printZone = resolveZoneToPhoto(printAreaRelGarment, garmentBbox);

      const compositeBuffer = await compositeDesignOnMockup({
        designUrl: productionDesignUrl,
        mockupUrl: template.imageUrl,
        printZone,
      });

      const previewKey = `pattern-preview/${patternId}-${Date.now()}.webp`;
      const { url } = await storagePut(previewKey, compositeBuffer, "image/webp");
      previewImageUrl = url;
      console.log(`[PatternProd] previewImageUrl (composite): ${previewImageUrl}`);
    } else {
      previewImageUrl = productionDesignUrl;
      console.log(`[PatternProd] No template found for workspace ${workspaceId}, using transparent PNG as preview`);
    }
  } catch (err) {
    console.warn(`[PatternProd] Composite failed, falling back to transparent PNG:`, err);
    previewImageUrl = productionDesignUrl;
  }

  // Step 7: Update previewImageUrl in DB
  await updateTrendPatternImage(patternId, previewImageUrl);
  console.log(`[PatternProd] Pattern ${patternId} done.`);

  return { productionDesignUrl, previewImageUrl };
}
