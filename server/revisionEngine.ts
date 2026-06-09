/**
 * Revision Engine — Phase G
 * Generates design revisions using GPT Image with reference image.
 * Karpathy: single-purpose functions, no speculative abstractions.
 */
import sharp from "sharp";
import { generateImage } from "./_core/imageGeneration";
import { removeBackground } from "./mockupCompositor";
import { storagePut } from "./storage";
import { nanoid } from "nanoid";
import { insertRevision, getNextIterationNumber } from "./revisionDb";

/** Build the revision prompt from instruction + concept metadata */
export function buildRevisionPrompt(
  instruction: string,
  concept: {
    conceptName: string;
    format: string;
    style: string;
    headline?: string | null;
    subtext?: string | null;
  },
  variationKey: string
): string {
  const variationLabel =
    variationKey === "A"
      ? "Clean/Commercial"
      : variationKey === "B"
        ? "Bold/Artistic"
        : "Trending/Social";

  return `You are revising a DTF t-shirt design. The original design is attached as reference.

DESIGN CONTEXT:
- Concept: ${concept.conceptName}
- Style: ${concept.style}
- Format: ${concept.format}
- Variation: ${variationKey} (${variationLabel})
${concept.headline ? `- Headline: ${concept.headline}` : ""}
${concept.subtext ? `- Subtext: ${concept.subtext}` : ""}

USER'S REVISION INSTRUCTION:
${instruction}

CONSTRAINTS (always maintain):
- DTF Silhouette Rule: NO solid background fills. White/transparent space visible between all elements.
- Outer shape must be an organic graphic silhouette (badge, arch, diamond, etc.) — NOT a rectangle.
- Print Safety: design must work as a physical transfer on fabric.
- Maintain the overall concept identity while applying the requested changes.
- Output a single cohesive design image with transparent or white background.`;
}

/** Generate a design revision using GPT Image with the original as reference */
export async function generateRevision(
  conceptId: number,
  variationKey: string,
  instruction: string,
  referenceImageUrl: string,
  conceptMeta: {
    conceptName: string;
    format: string;
    style: string;
    headline?: string | null;
    subtext?: string | null;
  }
): Promise<{ revisionId: string; imageUrl: string }> {
  // 1. Build prompt
  const prompt = buildRevisionPrompt(instruction, conceptMeta, variationKey);

  // 2. Call GPT Image generation with reference
  const result = await generateImage({
    prompt,
    originalImages: [{ url: referenceImageUrl, mimeType: "image/png" }],
  });
  const rawUrl = result.url;
  if (!rawUrl) throw new Error("Image generation returned no URL");

  // 2b. Strip the background BEFORE storing. The image model bakes in a white/opaque background
  // (it can't emit true transparency), so without this the Design Studio shows the revised design
  // sitting on a white box instead of transparency — the reported "it adds a background" bug.
  // removeBackground = edge-connected white flood-fill (preserves interior whites) with an
  // AI-extraction fallback for colored backgrounds; same cleanup every other design path uses.
  // On any failure we keep the raw image rather than blocking the revision.
  let imageUrl = rawUrl;
  try {
    const res = await fetch(rawUrl);
    if (res.ok) {
      const transparent = await removeBackground(Buffer.from(await res.arrayBuffer()));
      const { url } = await storagePut(
        `revisions/${conceptId}-${variationKey}-${Date.now()}.png`,
        transparent,
        "image/png",
      );
      imageUrl = url;
    }
  } catch (err) {
    console.warn(`[Revision] background removal failed for concept ${conceptId} ${variationKey}; using raw image:`, err);
  }

  // 3. Get next iteration number
  const iterationNumber = await getNextIterationNumber(conceptId, variationKey);

  // 4. Store revision record
  const revisionId = nanoid();
  await insertRevision({
    id: revisionId,
    conceptId,
    variationKey,
    iterationNumber,
    instruction,
    referenceImageUrl,
    resultImageUrl: imageUrl,
    accepted: false,
  });

  return { revisionId, imageUrl };
}

/**
 * Deterministically crop a design to its STRONG content — opaque pixels that are either dark
 * (navy/ink) OR saturated (the real graphic) — dropping faint/light low-contrast tails such as
 * the small disclaimer text under a design, and trimming surrounding empty space. NOTHING is
 * regenerated: every remaining pixel is byte-identical (PO 2026-06-09: "remove the white text +
 * trim, everything else stays the same" — AI revision can't guarantee that because it redraws the
 * whole image and hallucinates new elements). If no strong region is found (e.g. an all-light
 * design), falls back to a plain opaque-content trim so it never crops to nothing.
 */
export async function trimToStrongContent(designBuf: Buffer): Promise<Buffer> {
  const { data, info } = await sharp(designBuf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h, channels: ch } = info;
  const STRONG_LUM = 110;   // below = dark ink (navy/black)
  const STRONG_SAT = 70;    // above = saturated design color (yellow/blue/etc.)
  const PAD = 8;
  let sMinX = w, sMaxX = -1, sMinY = h, sMaxY = -1;        // strong-content bbox
  let aMinX = w, aMaxX = -1, aMinY = h, aMaxY = -1;        // any-opaque bbox (fallback)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * ch;
      if (data[i + 3] <= 30) continue;                     // transparent — skip
      if (x < aMinX) aMinX = x; if (x > aMaxX) aMaxX = x; if (y < aMinY) aMinY = y; if (y > aMaxY) aMaxY = y;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      const sat = Math.max(r, g, b) - Math.min(r, g, b);
      if (lum < STRONG_LUM || sat > STRONG_SAT) {
        if (x < sMinX) sMinX = x; if (x > sMaxX) sMaxX = x; if (y < sMinY) sMinY = y; if (y > sMaxY) sMaxY = y;
      }
    }
  }
  // Prefer the strong bbox when it covers a meaningful area; else fall back to opaque bbox.
  const strongOk = sMaxX >= sMinX && (sMaxX - sMinX) > w * 0.05 && (sMaxY - sMinY) > h * 0.05;
  const minX = strongOk ? sMinX : aMinX, maxX = strongOk ? sMaxX : aMaxX;
  const minY = strongOk ? sMinY : aMinY, maxY = strongOk ? sMaxY : aMaxY;
  if (maxX < minX || maxY < minY) return designBuf;        // nothing found — return as-is
  const left = Math.max(0, minX - PAD), top = Math.max(0, minY - PAD);
  const cw = Math.min(w - left, maxX - minX + 1 + PAD * 2);
  const cht = Math.min(h - top, maxY - minY + 1 + PAD * 2);
  return sharp(designBuf).extract({ left, top, width: cw, height: cht }).png().toBuffer();
}

/**
 * Deterministic "Clean & Trim" revision (NO AI): strip a solid white background to transparency
 * (edge-connected flood-fill — preserves interior whites like leggings), then crop to strong
 * content (removes faint disclaimer tails + trims). Produces a revision record like generateRevision
 * so it slots into the Design Studio accept/revert flow, but the design itself is untouched.
 */
export async function trimAndCleanRevision(
  conceptId: number,
  variationKey: string,
  referenceImageUrl: string,
): Promise<{ revisionId: string; imageUrl: string }> {
  const res = await fetch(referenceImageUrl);
  if (!res.ok) throw new Error(`Failed to download reference image: ${referenceImageUrl} (${res.status})`);
  const raw = Buffer.from(await res.arrayBuffer());
  // removeBackground here is deterministic for a design reference: passthrough if already
  // transparent, edge-connected white flood-fill if on white. (AI extraction only triggers for a
  // colored/scene background, which a clean design reference never has.)
  const noBg = await removeBackground(raw);
  const cleaned = await trimToStrongContent(noBg);

  const { url } = await storagePut(
    `revisions/${conceptId}-${variationKey}-${Date.now()}.png`,
    cleaned,
    "image/png",
  );

  const iterationNumber = await getNextIterationNumber(conceptId, variationKey);
  const revisionId = nanoid();
  await insertRevision({
    id: revisionId,
    conceptId,
    variationKey,
    iterationNumber,
    instruction: "Clean & Trim — remove faint text + trim (deterministic, no AI)",
    referenceImageUrl,
    resultImageUrl: url,
    accepted: false,
  });

  return { revisionId, imageUrl: url };
}
