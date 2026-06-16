/**
 * Revision Engine — Phase G
 * Generates design revisions using GPT Image with reference image.
 * Karpathy: single-purpose functions, no speculative abstractions.
 */
import sharp from "sharp";
import { callImageEdit } from "./patternProductionProcessor";
import { removeBackground } from "./mockupCompositor";
import { storagePut } from "./storage";
import { nanoid } from "nanoid";
import { insertRevision, getNextIterationNumber, snapshotGenerationToHistory } from "./revisionDb";
import { getConceptById } from "./db";

/** Build the revision prompt from instruction + concept metadata */
export type RevisionAspect = "1:1" | "3:4" | "4:3" | "9:16" | "16:9";

/** Map a PO-selected aspect to the gpt-image-1 size + an optional output dimension hint for the
 *  prompt. Only 3 native sizes exist; portrait/landscape choices collapse onto the closest. */
function aspectToSize(aspect: RevisionAspect): "1024x1024" | "1024x1536" | "1536x1024" {
  if (aspect === "1:1") return "1024x1024";
  if (aspect === "3:4" || aspect === "9:16") return "1024x1536";
  return "1536x1024"; // 4:3, 16:9
}

export function buildRevisionPrompt(
  instruction: string,
  concept: {
    conceptName: string;
    format: string;
    style: string;
    headline?: string | null;
    subtext?: string | null;
  },
  variationKey: string,
  aspect: RevisionAspect = "1:1",
): string {
  // A revision is a SURGICAL edit, not a redraw. The old prompt fed concept metadata + DTF
  // "silhouette/redraw" rules, which gave the image model licence to recompose — a simple text
  // swap (YEE DINK -> YEE HAW) came back with the top text cropped and an invented blue stripe
  // (PO-flagged 2026-06-10). Concept/variation metadata is intentionally NOT used: a faithful
  // edit reads the ATTACHED IMAGE, not a description that invites a fresh interpretation. Paired
  // with gpt-image-1 input_fidelity:"high", this keeps every untouched pixel in place.
  void concept;
  void variationKey;

  // Aspect 1:1 = original SURGICAL behavior (anti-outpaint guardrail). Non-square = the PO has
  // explicitly asked for a canvas-changing edit, so the "no crop / no rescale / no background change"
  // clauses are softened (still preserve the SUBJECT/text fidelity, but allow the canvas to grow into
  // the new aspect — otherwise the model fights itself, like the YEE HAW "extend vertically" miss).
  if (aspect === "1:1") {
    return `You are making a SURGICAL edit to the attached design image. Apply ONLY this change, exactly as written, and nothing more:

"${instruction}"

Keep EVERYTHING ELSE pixel-for-pixel identical to the attached image:
- the exact composition, framing, and canvas — do NOT crop, zoom, rescale, or shift the artwork; keep every element (especially text) fully inside the frame and never cut off;
- every other word and letter at the SAME size, position, font, weight, and colour;
- the background EXACTLY as it is, including every stripe, colour, and pattern — do NOT add, remove, recolour, or restyle any background element (no new lines, shapes, or fills);
- every character, graphic, and decoration, unchanged.

Do NOT redraw, restyle, recolour, resize, reposition, or add/remove ANYTHING the instruction did not explicitly name. Change only what the instruction asks; leave all else exactly as in the attached image.`;
  }

  // Non-square (canvas-changing) revision — the ONLY thing changing is the CANVAS dimensions. The
  // artwork itself is preserved pixel-for-pixel, same as the 1:1 surgical branch. The aspect change
  // is never licence to redraw, restyle, or "reinterpret" any existing element. Without this strong
  // universal-preservation clause, the PO has to manually append "keep all elements the same besides
  // that" to every non-square revision (PO 2026-06-16).
  return `You are making a SURGICAL canvas change to the attached design image. The ONLY change is the canvas aspect — everything else is preserved pixel-for-pixel. Apply this change, exactly as written, and nothing more:

"${instruction}"

The new canvas is ${aspect}. Keep EVERYTHING in the attached image pixel-for-pixel identical:
- every existing element (subject, character, illustration, text, decoration, background pattern) at the SAME size, position, pose, proportions, font, weight, colour, and palette as the attached image — do NOT redraw, restyle, recolour, resize, reposition, simplify, or reinterpret any of it;
- every letter and word exactly as written, never cropped, never resized;
- the existing background art (stripes, colours, pattern, texture) unchanged where it already exists.

The ONLY new pixels you may paint are in the EXTRA canvas space created by the new aspect ratio, and those new pixels must be a seamless continuation of the existing background (same stripes, colours, pattern, texture) — never a different style, never new subjects or decorations the instruction did not explicitly name. Do NOT crop or cut off any existing element; reposition the existing artwork within the new canvas only as needed so nothing is clipped. Transparent background where the existing design is transparent.

Do NOT add, remove, redraw, or change ANYTHING the instruction did not explicitly name. Change only the canvas; leave all artwork exactly as in the attached image.`;
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
  },
  aspect: RevisionAspect = "1:1",
): Promise<{ revisionId: string; imageUrl: string }> {
  // Snapshot the CURRENT design into generation history BEFORE this edit replaces it. The Design Studio
  // edit path was the one overwrite path that skipped this, so "YEE DINK"→"YEE HAW" lost the original
  // (PO 2026-06-16, data loss). URL-deduped (revisionDb.ts), so repeat edits never stack the same design.
  const priorConcept = await getConceptById(conceptId);
  if (priorConcept?.imageUrlA) await snapshotGenerationToHistory(conceptId, priorConcept.imageUrlA, priorConcept.style);

  // 1. Build the edit prompt — aspect-aware (1:1 = surgical, non-square = canvas-extending).
  const prompt = buildRevisionPrompt(instruction, conceptMeta, variationKey, aspect);

  // 2. Faithful edit via gpt-image-1 /v1/images/edits with input_fidelity:"high" — the lever that
  // preserves the parts of the design the instruction did NOT touch. The previous Forge
  // GenerateImage path had no fidelity control, so a simple text swap recomposed the design
  // (cropped the top text, invented a blue stripe — PO-flagged 2026-06-10).
  //
  // PAD-TO-SQUARE (PO-approved fix 2026-06-11, bake-off verified): for the SURGICAL 1:1 path,
  // gpt-image-1 only renders square/landscape/portrait canvases, so a non-square reference forced a
  // re-frame — size:"auto" OUTPAINTED (the "extended" failure) and a bare fixed square CLIPPED the
  // top text. Padding to a square with TRANSPARENT margins means the canvas matches, the model edits
  // in place, and the margins trim back off after.
  //
  // ASPECT-AWARE (PO 2026-06-16, "Aspect ratio" picker): when the PO explicitly chooses a non-square
  // aspect (e.g. "extend vertically" → 9:16), we SKIP the pad-to-square and ask gpt-image-1 directly
  // for that aspect. This is the path that was missing — the YEE HAW "extend vertically" miss is
  // because the engine forced everything back into a square no matter what the instruction said.
  const refRes = await fetch(referenceImageUrl);
  if (!refRes.ok) throw new Error(`Failed to download reference image: ${referenceImageUrl} (${refRes.status})`);
  const refRaw = Buffer.from(await refRes.arrayBuffer());
  const targetSize = aspectToSize(aspect);
  let refPng: Buffer;
  if (aspect === "1:1") {
    const refMeta = await sharp(refRaw).metadata();
    const side = Math.max(refMeta.width ?? 0, refMeta.height ?? 0);
    if (!side) throw new Error("reference image has no dimensions");
    const padX = side - (refMeta.width ?? 0);
    const padY = side - (refMeta.height ?? 0);
    refPng = await sharp(refRaw)
      .ensureAlpha()
      .extend({
        top: Math.floor(padY / 2),
        bottom: Math.ceil(padY / 2),
        left: Math.floor(padX / 2),
        right: Math.ceil(padX / 2),
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .png()
      .toBuffer();
  } else {
    // PAD-TO-TARGET-ASPECT (PO 2026-06-16, bug fix on the 9:16 YEE HAW miss): the previous version
    // passed the square reference AS-IS and asked gpt-image-1 for a 1024x1536 / 1536x1024 output. The
    // canvas mismatch let the model recompose — it redrew the llama larger, clipped YEE HAW, dropped
    // the sparkle. Mirror the 1:1 trick instead: contain-fit the reference into the target dimensions
    // and pad the remainder with TRANSPARENT margins so the existing pixels physically stay put. The
    // model can ONLY paint into the transparent space (the new canvas room created by the aspect).
    const refMeta = await sharp(refRaw).metadata();
    const sw = refMeta.width ?? 0, sh = refMeta.height ?? 0;
    if (!sw || !sh) throw new Error("reference image has no dimensions");
    const [tw, th] = targetSize === "1024x1536" ? [1024, 1536] : [1536, 1024];
    const scale = Math.min(tw / sw, th / sh);
    const rw = Math.round(sw * scale), rh = Math.round(sh * scale);
    const padX = tw - rw, padY = th - rh;
    refPng = await sharp(refRaw)
      .ensureAlpha()
      .resize(rw, rh, { fit: "fill" })
      .extend({
        top: Math.floor(padY / 2),
        bottom: Math.ceil(padY / 2),
        left: Math.floor(padX / 2),
        right: Math.ceil(padX / 2),
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .png()
      .toBuffer();
  }
  const edited = await callImageEdit(refPng, "design.png", prompt, {
    transparent: true, // The reference design is a TRANSPARENT png. Ask gpt-image-1 for a transparent
                       // result so it KEEPS that. transparent:false made it fill the transparent corners
                       // with opaque BLACK, which the white-only removeBackground couldn't strip — the
                       // "lost transparency" regression (PO-flagged 2026-06-10). gpt-image-1
                       // background:transparent is the proven-reliable transparency path (same as the
                       // niche Step-2 extract); input_fidelity:high keeps the striped backdrop intact.
    inputFidelity: "high", // the faithfulness lever (preserve untouched pixels) — independent of quality
    quality: "medium", // submitRevision is a sync mutation with NO retry net; "high" (~90-180s) risks a
                       // Cloudflare 524. "medium" (~30-60s) stays under the edge timeout; the PO
                       // visually approved the medium-quality padded output (2026-06-11).
    size: targetSize, // 1:1 → 1024x1024 (legacy surgical), portrait → 1024x1536, landscape → 1536x1024
  });

  // 2b. Safety net only: gpt-image-1 already returns native transparency above. If a run instead
  // comes back on a white box, strip it (edge-connected white flood-fill; passthrough when already
  // transparent, so it's a no-op on the normal path). Never blocks the revision.
  let finalBuf = edited;
  try {
    finalBuf = await removeBackground(edited);
  } catch (err) {
    console.warn(`[Revision] background cleanup failed for concept ${conceptId} ${variationKey}; using raw edit:`, err);
  }
  // 2c. Trim the transparent padding margins back off (inverse of the pad-to-square above) — ONLY
  // for the 1:1 surgical path. A non-square aspect was deliberately chosen by the PO, so trimming
  // would defeat the whole feature (it would chop the extended canvas back down to content bounds).
  if (aspect === "1:1") {
    try {
      finalBuf = await sharp(finalBuf).trim({ threshold: 10 }).png().toBuffer();
    } catch (err) {
      console.warn(`[Revision] padding trim failed for concept ${conceptId} ${variationKey}; using untrimmed:`, err);
    }
  }
  const { url: imageUrl } = await storagePut(
    `revisions/${conceptId}-${variationKey}-${Date.now()}.png`,
    finalBuf,
    "image/png",
  );

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
  // Snapshot the current design before this trim/clean replaces it (PO 2026-06-16 data-loss fix).
  const priorConcept = await getConceptById(conceptId);
  if (priorConcept?.imageUrlA) await snapshotGenerationToHistory(conceptId, priorConcept.imageUrlA, priorConcept.style);

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
