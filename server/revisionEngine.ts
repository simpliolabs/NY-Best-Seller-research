/**
 * Revision Engine — Phase G
 * Generates design revisions using GPT Image with reference image.
 * Karpathy: single-purpose functions, no speculative abstractions.
 */
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
