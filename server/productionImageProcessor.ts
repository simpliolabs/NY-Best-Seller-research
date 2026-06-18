/**
 * Production Image Processor — v4 (rembg primary, Kontext fallback, PO 2026-06-17)
 *
 * Converts a raw generated design image into a production-ready transparent PNG.
 *
 * Architecture:
 * 1. PRIMARY — fal-ai/imageutils/rembg: purpose-built bg-removal (~$0.001/call, ~2-5s).
 *    Deterministic mask, no prompt to misinterpret, no model deciding what to preserve.
 *    Returns a transparent PNG directly — no chromakey step needed.
 * 2. FALLBACK — FLUX.1 Kontext: only fires when rembg errors. Repaints BG magenta,
 *    chromakey strips it. ~$0.04/call. Insurance for the rare segmentation edge case.
 * 3. Crop to content bounds and upload to S3.
 *
 * Why v4 (replaces v3 Kontext-primary): v3 used Kontext for every bg-removal, which is
 * an instruction-driven creative model — overkill for "strip the background." rembg
 * is the right tool: segmentation model, not a generation model. 40x cheaper, faster,
 * one fewer post-processing step (rembg returns transparent direct, no chromakey).
 *
 * Why v3 was needed at all (and why v4 keeps the Kontext fallback): v2 was gpt-image-2
 * in GENERATE mode — passed the source as a "style reference" and got back a
 * creatively-reinterpreted new design (PADDLE WHISPERER came back as a different llama,
 * PO 2026-06-17). v3 fixed the redraw bug; v4 makes it cheap and fast.
 */
import sharp from "sharp";
import { storagePut } from "./storage";
import { updateConceptProductionUrl } from "./db";
import { chromakeyFromCorners } from "./chromakey";

/**
 * Remove the background from the source design using fal-ai/imageutils/rembg via the
 * fal queue API. Returns a transparent PNG buffer directly — no chromakey step needed.
 *
 * rembg is a dedicated segmentation model (BiRefNet / U²-Net family), not a generative
 * one — so the subject pixels are preserved without instruction-following risk. Fast
 * (~2-5s), cheap (~$0.001/call), deterministic mask.
 *
 * Requires FAL_KEY (already in the prod env — used by patternProductionProcessor,
 * revisionEngine.generateRevisionViaFalKontext, and the Kontext fallback below).
 */
async function removeBackgroundViaRembg(sourceImageUrl: string): Promise<Buffer> {
  const key = process.env.FAL_KEY;
  if (!key) throw new Error("FAL_KEY is not configured");
  const headers = { Authorization: `Key ${key}`, "Content-Type": "application/json" };

  console.log(`[ProdProcessor v4] Removing background via rembg. Source: ${sourceImageUrl.substring(0, 80)}...`);

  const submit = await fetch("https://queue.fal.run/fal-ai/imageutils/rembg", {
    method: "POST",
    headers,
    body: JSON.stringify({ image_url: sourceImageUrl }),
  });
  if (!submit.ok) {
    throw new Error(`fal rembg submit error (${submit.status}): ${(await submit.text()).slice(0, 300)}`);
  }
  const { status_url, response_url } = (await submit.json()) as {
    status_url: string;
    response_url: string;
  };

  // Same poll pattern as the other fal callers. rembg is much faster (~2-5s typical)
  // but the cap matches Kontext's so SDK-quirk timeouts behave the same way.
  let completed = false;
  for (let i = 0; i < 80; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const st = (await (await fetch(status_url, { headers })).json()) as {
      status?: string;
      error?: unknown;
    };
    if (st.status === "COMPLETED") { completed = true; break; }
    if (st.status === "FAILED" || st.error) {
      throw new Error(`fal rembg failed: ${JSON.stringify(st).slice(0, 300)}`);
    }
  }
  if (!completed) throw new Error("fal rembg timed out after 240s");

  // rembg returns `{ image: { url, ... } }` (singular); other fal models use `images[0]`.
  // Handle both shapes defensively.
  const out = (await (await fetch(response_url, { headers })).json()) as {
    image?: { url: string };
    images?: Array<{ url: string }>;
  };
  const url = out.image?.url ?? out.images?.[0]?.url;
  if (!url) throw new Error(`fal rembg returned no image: ${JSON.stringify(out).slice(0, 200)}`);

  const dl = await fetch(url);
  if (!dl.ok) throw new Error(`Failed to download rembg output: ${dl.status}`);
  return Buffer.from(await dl.arrayBuffer());
}

/**
 * Kontext fallback — only fires when rembg errors. Same identity-preserving "isolate
 * subject onto magenta backdrop" approach as v3; downstream chromakey strips the magenta.
 * ~$0.04/call vs rembg's $0.001, so we only use it when rembg can't.
 */
async function isolateSubjectViaKontext(sourceImageUrl: string): Promise<Buffer> {
  const key = process.env.FAL_KEY;
  if (!key) throw new Error("FAL_KEY is not configured");
  const headers = { Authorization: `Key ${key}`, "Content-Type": "application/json" };

  // Kontext follows instructions literally — say exactly what we want and call out
  // what to preserve. The subject-preservation language is the load-bearing part.
  const prompt = [
    "Remove the background from the attached image: keep the subject (the main illustration,",
    "characters, mascots, typography, badges, props) pixel-for-pixel IDENTICAL — same pose,",
    "same proportions, same colors, same fonts, same composition. Do NOT redesign, restyle,",
    "recolor, resize, or reposition any part of the subject. Replace ONLY the background with",
    "solid hot pink magenta (#FF00FF) filling every pixel that is not part of the subject.",
    "Hard clean edge between the subject and the magenta — no blending, no gradient, no fade.",
    "No shirt, no garment, no fabric texture, no scene, no backdrop, no frame — just the",
    "subject on solid magenta.",
  ].join(" ");

  console.log(`[ProdProcessor v3] Isolating subject via Kontext. Source: ${sourceImageUrl.substring(0, 80)}...`);

  const submit = await fetch("https://queue.fal.run/fal-ai/flux-pro/kontext", {
    method: "POST",
    headers,
    body: JSON.stringify({
      prompt,
      image_url: sourceImageUrl,
      safety_tolerance: "6", // most permissive — design content (mascots, slogans) trips lower
    }),
  });
  if (!submit.ok) {
    throw new Error(`fal Kontext submit error (${submit.status}): ${(await submit.text()).slice(0, 300)}`);
  }
  const { status_url, response_url } = (await submit.json()) as {
    status_url: string;
    response_url: string;
  };

  // Poll until COMPLETED — same pattern as patternProductionProcessor.callFalKontextEdit
  // and revisionEngine.generateRevisionViaFalKontext (~3s × 80 = 240s cap).
  let completed = false;
  for (let i = 0; i < 80; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const st = (await (await fetch(status_url, { headers })).json()) as {
      status?: string;
      error?: unknown;
    };
    if (st.status === "COMPLETED") { completed = true; break; }
    if (st.status === "FAILED" || st.error) {
      throw new Error(`fal Kontext failed: ${JSON.stringify(st).slice(0, 300)}`);
    }
  }
  if (!completed) throw new Error("fal Kontext timed out after 240s");

  const out = (await (await fetch(response_url, { headers })).json()) as {
    images?: Array<{ url: string }>;
  };
  const url = out.images?.[0]?.url;
  if (!url) throw new Error(`fal Kontext returned no image: ${JSON.stringify(out).slice(0, 200)}`);

  const dl = await fetch(url);
  if (!dl.ok) throw new Error(`Failed to download Kontext output: ${dl.status}`);
  return Buffer.from(await dl.arrayBuffer());
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
 * Pipeline (v4):
 *  - already-transparent → just crop to content bounds (cheapest, no AI)
 *  - Manual upload → local removeBackground (sharp flood-fill, no AI)
 *  - everything else → fal rembg (primary) → Kontext+chromakey (fallback) → crop → upload
 *
 * @param imageUrl - URL of the raw generated design image
 * @param conceptId - DB concept ID
 * @param variation - A/B/C variation key
 * @param promptDescription - kept for back-compat; no longer fed to any model (subject is read
 *   from the image itself, so the description was noise + the source of v2's redraw risk)
 * @returns URL of the production-ready transparent PNG in S3
 */
export async function processDesignForProduction(
  imageUrl: string,
  conceptId: number,
  variation: "A" | "B" | "C",
  promptDescription?: string,
  isManual = false,
): Promise<string> {
  console.log(`[ProdProcessor v4] Processing concept ${conceptId} variation ${variation}...`);

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
    console.log(`[ProdProcessor v4] Image already transparent (${(transparentRatio * 100).toFixed(1)}%), cropping only`);
    transparentPng = await cropToContent(srcBuf);
  } else if (isManual) {
    // Manual upload (PO 2026-06-15 bug #1): a FINISHED user design on a literal background. Remove the
    // bg LOCALLY (white → flood-fill, colored → AI-extraction fallback) — never use the AI path,
    // which used to redraw the user's own art (the original v2 gpt-image-2 generate-mode bug).
    console.log(`[ProdProcessor v4] Manual upload — local background removal, no AI regeneration`);
    const { removeBackground } = await import("./mockupCompositor");
    const removed = await removeBackground(srcBuf);
    transparentPng = await cropToContent(removed);
  } else {
    // PRIMARY: rembg returns transparent PNG directly. No prompt, no chromakey, deterministic mask.
    // FALLBACK: Kontext on rembg error — paints magenta backdrop, chromakey strips it. promptDescription
    // is intentionally unused; both models read the subject from the image, so any text description is
    // just noise (and was where the v2 path's "creative reinterpretation" risk lived).
    void promptDescription;
    try {
      const rembgOut = await removeBackgroundViaRembg(imageUrl);
      transparentPng = await cropToContent(rembgOut);
    } catch (rembgErr) {
      console.warn(`[ProdProcessor v4] rembg failed; falling back to Kontext for concept ${conceptId} ${variation}:`, rembgErr);
      const rawMagenta = await isolateSubjectViaKontext(imageUrl);
      const keyed = await chromakeyFromCorners(rawMagenta);
      transparentPng = await cropToContent(keyed);
    }
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
