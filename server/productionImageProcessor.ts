/**
 * Production Image Processor — v5 (pass-through, PO 2026-06-17)
 *
 * Converts a raw generated design image into a production-ready PNG.
 *
 * Architecture:
 *  - already-transparent → crop to content bounds (no AI)
 *  - Manual upload → local removeBackground (sharp flood-fill, no AI)
 *  - everything else → PASS THROUGH AS-IS (no AI, no bg-removal)
 *
 * Why v5 (drops v3 Kontext + v4 rembg, PO 2026-06-17 — "regressed by 1 month"):
 *  - The photoreal raccoon on a night street has the scene AS PART of the design — meant to print
 *    as a full panel. rembg stripped the scene, leaving just the raccoon.
 *  - The Stuck-at-3.5 V1 design had an intentional dark vintage backdrop. rembg stripped it.
 *  - Many Bold Typographic / Vintage / Collegiate designs ship with intentional full-canvas
 *    backdrops; users print them as panels.
 * Treating every background as "to be removed" was the architectural mistake. The user already has
 * the revision engine (fc28368) for explicit bg-removal when they want it — that's a photo-editor
 * action, not a mockup-prep default.
 *
 * Lineage: v2 (gpt-image-2 redraw, dropped — silently produced new designs), v3 (Kontext bg-removal,
 * dropped — same root issue as v4), v4 (rembg, dropped — stripped intentional backgrounds), v5
 * (current — trust the design, do nothing AI).
 */
import sharp from "sharp";
import { storagePut } from "./storage";
import { updateConceptProductionUrl } from "./db";

// v3/v4 helpers (removeBackgroundViaRembg, isolateSubjectViaKontext) deleted with v5 (PO 2026-06-17).
// Both were AI bg-removal that stripped intentional design backgrounds (raccoon-on-night-street,
// Stuck-at-3.5 V1 dark backdrop). User now triggers bg-removal explicitly via the revision engine
// when they want it.

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
 * Process a raw design image URL into a production-ready PNG.
 *
 * Pipeline (v5 — PO 2026-06-17, "your last rounds of MOCKUP image editing has regressed the
 * system by 1 month"):
 *  - already-transparent → crop to content bounds (no AI)
 *  - Manual upload → local removeBackground (sharp flood-fill, no AI)
 *  - everything else → PASS THROUGH AS-IS (no AI, no bg-removal)
 *
 * Why v5 (drops v3 Kontext + v4 rembg): bg-removal turned out to be the wrong default. Many
 * pipeline-generated designs have INTENTIONAL full-canvas backgrounds — a photoreal raccoon on a
 * night street is meant to print as a full panel; a Collegiate/Varsity design with a vintage
 * backdrop is meant to print with the backdrop. v4 rembg ripped those out, leaving just the
 * subject, which broke the designs the user wanted. v3 had the same problem.
 *
 * The user already has a clean photo-editor revision flow (revisionEngine, fc28368) for EXPLICIT
 * bg-removal when they want it ("remove the green background"). The default mockup-prep step now
 * respects what the pipeline produced — designs go on shirts as they were drawn.
 *
 * @param imageUrl - URL of the raw generated design image
 * @param conceptId - DB concept ID
 * @param variation - A/B/C variation key
 * @param promptDescription - unused; kept for back-compat with existing callers
 * @returns URL of the production-ready PNG in S3
 */
export async function processDesignForProduction(
  imageUrl: string,
  conceptId: number,
  variation: "A" | "B" | "C",
  promptDescription?: string,
  isManual = false,
): Promise<string> {
  void promptDescription;
  console.log(`[ProdProcessor v5] Processing concept ${conceptId} variation ${variation}...`);

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
    console.log(`[ProdProcessor v5] Image already transparent (${(transparentRatio * 100).toFixed(1)}%), cropping only`);
    transparentPng = await cropToContent(srcBuf);
  } else if (isManual) {
    // Manual upload (PO 2026-06-15 bug #1): a FINISHED user design on a literal background — typically
    // a photo on white. Local flood-fill strips the white, leaves any interior whites. No AI.
    console.log(`[ProdProcessor v5] Manual upload — local background removal, no AI`);
    const { removeBackground } = await import("./mockupCompositor");
    const removed = await removeBackground(srcBuf);
    transparentPng = await cropToContent(removed);
  } else {
    // PASS THROUGH (PO 2026-06-17): pipeline-generated designs are kept as-is — many have INTENTIONAL
    // full-canvas backgrounds (photoreal raccoon on night street, Vintage/Varsity vintage backdrop)
    // that the user wants printed as a full panel. If the user wants the bg stripped, they use the
    // revision engine ("remove the green background") explicitly. cropToContent is a no-op on a fully
    // opaque image (full-canvas content bbox), so this just round-trips the bytes through storage.
    console.log(`[ProdProcessor v5] Generated design — passing through as-is (no bg-removal)`);
    transparentPng = await cropToContent(srcBuf);
  }

  // Upload to S3
  const fileKey = `production/${conceptId}-${variation}-${Date.now()}.png`;
  const { url } = await storagePut(fileKey, transparentPng, "image/png");

  // Save to DB
  await updateConceptProductionUrl(conceptId, variation, url);

  console.log(`[ProdProcessor v5] Done: concept ${conceptId} variation ${variation} → ${url}`);
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
