/**
 * Revision Engine — Phase G
 * Generates design revisions using GPT Image with reference image.
 * Karpathy: single-purpose functions, no speculative abstractions.
 */
import { generateImage } from "./_core/imageGeneration";
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
  const imageUrl = result.url;
  if (!imageUrl) throw new Error("Image generation returned no URL");

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
