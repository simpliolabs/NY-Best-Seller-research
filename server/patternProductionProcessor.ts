/**
 * Pattern Production Processor
 *
 * Two-step pipeline for trend_patterns:
 * 1. generateStandaloneDesign — gpt-image-1 /edits + background:"transparent"
 *    → productionDesignUrl (transparent PNG, canonical asset)
 * 2. compositePatternPreview — transparent PNG + first workspace template
 *    → previewImageUrl (how-it-looks-on-a-shirt thumbnail)
 *
 * Architecture decision (Option B, PO-approved):
 * - previewImageUrl = compositor output (transparent PNG + default template)
 * - dtfImageUrl = upscaled productionDesignUrl (no flood-fill, no extraction)
 * - gpt-image-1 with background:"transparent" returns a native transparent PNG —
 *   no chromakey step needed. gpt-image-2 does NOT support this parameter.
 *
 * Default template selection: first product group by createdAt ASC,
 * first template by sortOrder ASC. If no product group exists for the workspace,
 * previewImageUrl is set to the transparent PNG directly (acceptable fallback).
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

// ─── Artwork extraction ─────────────────────────────────────────────────────────

/**
 * Extract the artwork/print area from a shirt product photo.
 * Etsy source images are typically shirt flat-lays (~2000x2000px).
 * The print area is in the center of the image.
 * Cropping prevents gpt-image-1 from treating the shirt as part of the subject.
 *
 * Crop region: 25% from each side, 25% from top, 50% height.
 * This eliminates shirt necklines, collars, and labels on all flat-lay styles.
 * Validated visually: on 2000x2000 flat-lay with visible neckline at ~12%,
 * 25% top offset clears it completely while preserving the full artwork.
 */
async function extractArtworkArea(imgBuf: Buffer): Promise<Buffer> {
  const metadata = await sharp(imgBuf).metadata();
  const w = metadata.width ?? 1000;
  const h = metadata.height ?? 1000;

  // Crop center print area: 25% margin on sides, 25% from top, 50% height
  // This is the "chest zone" where the artwork lives on a graphic tee
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

// ─── Standalone design generation ─────────────────────────────────────────────

/**
 * Generate a standalone design with transparent background using gpt-image-1.
 * gpt-image-1 is the only OpenAI image model that honors background: "transparent"
 * on /v1/images/edits. gpt-image-2 rejects this parameter with HTTP 400.
 * The source image is passed as a style reference — NOT as the edit canvas.
 * Returns the raw transparent PNG buffer from the API.
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
  // Etsy source images are typically shirt flat-lays. The artwork/print is in the
  // center ~60% of the image. Cropping to this area prevents the model from
  // treating the shirt as part of the subject.
  const imgPng = await extractArtworkArea(imgBuf);

  // Edit instruction: surgical replace/add — NOT a new image creation.
  // The source image is the canvas. We only tell the model what to change.
  const prompt = promptDescription;

  console.log(`[PatternProd] Generating standalone design (gpt-image-1, transparent). Prompt: "${prompt.substring(0, 120)}..."`);

  const formData = new FormData();
  formData.append("model", "gpt-image-1");
  formData.append("prompt", prompt);
  formData.append("size", "1024x1024");
  formData.append("quality", "high");
  formData.append("background", "transparent");
  const blob = new Blob([new Uint8Array(imgPng)], { type: "image/png" });
  formData.append("image[]", blob, "style_reference.png");

  const resp = await fetch("https://api.openai.com/v1/images/edits", {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}` },
    body: formData,
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`gpt-image-1 API error (${resp.status}): ${errText.substring(0, 300)}`);
  }

  const data = await resp.json() as { data: Array<{ b64_json?: string; url?: string }> };
  const item = data.data?.[0];
  if (!item) throw new Error("gpt-image-1 returned no image data");

  if (item.b64_json) {
    return Buffer.from(item.b64_json, "base64");
  } else if (item.url) {
    const dlResp = await fetch(item.url);
    if (!dlResp.ok) throw new Error(`Failed to download generated image: ${dlResp.status}`);
    return Buffer.from(await dlResp.arrayBuffer());
  }
  throw new Error("gpt-image-1 response has neither b64_json nor url");
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

// ─── Default template selection ───────────────────────────────────────────────

/**
 * Get the first mockup template for a workspace (by createdAt ASC, then sortOrder ASC).
 * Returns null if no product group or templates exist for the workspace.
 */
async function getFirstWorkspaceTemplate(workspaceId: string) {
  const groups = await getProductGroupsByWorkspace(workspaceId);
  if (groups.length === 0) return null;

  // Sort by createdAt ascending to get the first group
  const firstGroup = groups.sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  )[0];

  const templates = await getMockupsByGroup(firstGroup.id);
  if (templates.length === 0) return null;

  // Templates are already ordered by sortOrder ASC from getMockupsByGroup
  return { template: templates[0], group: firstGroup };
}

// ─── Main entry point ─────────────────────────────────────────────────────────

/**
 * Full production pipeline for a single trend pattern.
 *
 * Steps:
 * 1. gpt-image-1 /edits + background:"transparent" → native transparent PNG
 * 2. Crop to content bounding box → productionDesignUrl (canonical transparent asset)
 * 3. Composite onto first workspace template → previewImageUrl
 *    (if no template exists, previewImageUrl = productionDesignUrl)
 *
 * Resolution note: gpt-image-1 max is 1024x1024 at this quality setting.
 * DTF upscale path (1024→3600 = 3.52×) is handled by patternDtfProcessor.ts.
 * This is more aggressive than the prior gpt-image-2 path (2048→3600 = 1.76×).
 * Monitor DTF sharpness on first 5 production runs; Real-ESRGAN may be needed sooner.
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

  // Step 1: Generate standalone design with transparent background (gpt-image-1)
  const rawTransparent = await generateStandaloneDesign(sourceImageUrl, promptDescription);

  // Step 2: Crop to content bounding box (no chromakey needed — gpt-image-1 returns native transparency)
  const transparentPng = await cropToContent(rawTransparent);

  // Step 3: Upload transparent PNG as productionDesignUrl
  const prodKey = `pattern-production/${patternId}-${Date.now()}.png`;
  const { url: productionDesignUrl } = await storagePut(prodKey, transparentPng, "image/png");
  await updateTrendPatternProductionUrl(patternId, productionDesignUrl);
  console.log(`[PatternProd] productionDesignUrl: ${productionDesignUrl}`);

  // Step 4: Composite onto first workspace template for previewImageUrl
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
      // No template available — use transparent PNG as preview fallback
      previewImageUrl = productionDesignUrl;
      console.log(`[PatternProd] No template found for workspace ${workspaceId}, using transparent PNG as preview`);
    }
  } catch (err) {
    // Composite failed — fall back to transparent PNG
    console.warn(`[PatternProd] Composite failed, falling back to transparent PNG:`, err);
    previewImageUrl = productionDesignUrl;
  }

  // Step 5: Update previewImageUrl in DB
  await updateTrendPatternImage(patternId, previewImageUrl);
  console.log(`[PatternProd] Pattern ${patternId} done.`);

  return { productionDesignUrl, previewImageUrl };
}
