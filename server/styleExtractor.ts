/**
 * Style Extractor — Style-Faithful Pipeline
 * Karpathy P2: one function, one purpose. No class hierarchy.
 *
 * Analyzes a source Etsy product image via Vision LLM and returns a structured
 * SourceStyleJSON describing the visual style in reproducible, actionable terms.
 * Used by nicheHunter.ts (Step 1b) to inform style-faithful image generation.
 */
import { invokeLLM } from "./_core/llm";
import type { SourceStyleJSON } from "../shared/sourceStyleJson";

/**
 * Extract visual style from a source Etsy product image URL.
 * Returns null if the image URL is unavailable or extraction fails.
 * Failure is non-fatal — the scan continues with prompt_only mode.
 */
export async function extractStyleFromImage(imageUrl: string): Promise<SourceStyleJSON | null> {
  try {
    const response = await invokeLLM({
      messages: [
        {
          role: "system",
          content: `You are a print-on-demand design expert who analyzes t-shirt product photos.
Your job is to extract the REPRODUCIBLE VISUAL STYLE of the printed graphic — not the shirt itself.
Focus on attributes that a designer could use to recreate the same style for a different subject.
Be precise and specific. Use concrete terms, not vague adjectives.
Return ONLY valid JSON matching the exact schema provided.`,
        },
        {
          role: "user",
          content: [
            {
              type: "image_url" as const,
              image_url: { url: imageUrl, detail: "high" as const },
            },
            {
              type: "text" as const,
              text: `Analyze the printed graphic design on this t-shirt product photo.
Extract the visual style into the following JSON structure.
Focus ONLY on the printed artwork — ignore the garment color, background, and props.

Return this exact JSON:
{
  "inkColors": ["list of actual ink colors used in the design, e.g. black, white, rust orange"],
  "inkColorNames": ["descriptive names for each ink color, e.g. matte black, distressed rust"],
  "shirtColorRole": "how the shirt color functions: 'negative space — shirt IS the background' OR 'covered by design'",
  "technique": "one of: screen-print simulation, DTG full-color, vinyl cut, embroidery simulation, watercolor wash",
  "lineWeight": "one of: thick bold outlines, medium outlines, hairline detail, no outlines",
  "shadingMethod": "one of: halftone dots, crosshatch, flat color, gradient, stippling, NONE",
  "textureDetail": "one of: heavy distress/worn, light distress, clean vector, hand-drawn organic, rough brush",
  "subject": "describe the main subject in 3-8 words, e.g. skeleton holding fishing rod",
  "subjectCrop": "one of: full body centered, bust portrait, close-up face, object only, scene/landscape",
  "composition": "one of: centered single subject, badge/emblem, left chest logo, full-back scene, stacked text, text-dominant",
  "framingDevice": "one of: circular badge border, banner ribbon, rectangular frame, arc text, NONE",
  "scaleCoverage": "how much of the print area the design fills, e.g. fills 80% of print area, small chest logo, full-chest",
  "textPresence": "describe text placement and style, e.g. bold headline above subject, subtext below, OR NONE",
  "textStyle": "one of: distressed serif all-caps, hand-lettered script, bold sans-serif, retro block letters, NONE",
  "mood": "one of: irreverent humor, vintage nostalgia, aggressive/bold, wholesome/cute, dark/edgy, inspirational",
  "humorMechanism": "one of: absurdist juxtaposition, wordplay/pun, self-deprecating, inside joke, NONE",
  "printMethod": "one of: simulated screen-print, DTG full-color, sublimation, embroidery, vinyl",
  "garmentStyle": "describe the shirt visible in the photo, e.g. dark heather tee, natural cotton, black hoodie",
  "designEra": "one of: 1970s retro, 1980s neon, 1990s grunge, vintage americana, modern minimal, timeless/classic",
  "backgroundTreatment": "one of: transparent/no background, white rectangle, shirt IS background, colored panel"
}`,
            },
          ],
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "source_style",
          strict: true,
          schema: {
            type: "object",
            properties: {
              inkColors: { type: "array", items: { type: "string" } },
              inkColorNames: { type: "array", items: { type: "string" } },
              shirtColorRole: { type: "string" },
              technique: { type: "string" },
              lineWeight: { type: "string" },
              shadingMethod: { type: "string" },
              textureDetail: { type: "string" },
              subject: { type: "string" },
              subjectCrop: { type: "string" },
              composition: { type: "string" },
              framingDevice: { type: "string" },
              scaleCoverage: { type: "string" },
              textPresence: { type: "string" },
              textStyle: { type: "string" },
              mood: { type: "string" },
              humorMechanism: { type: "string" },
              printMethod: { type: "string" },
              garmentStyle: { type: "string" },
              designEra: { type: "string" },
              backgroundTreatment: { type: "string" },
            },
            required: [
              "inkColors", "inkColorNames", "shirtColorRole", "technique", "lineWeight",
              "shadingMethod", "textureDetail", "subject", "subjectCrop", "composition",
              "framingDevice", "scaleCoverage", "textPresence", "textStyle", "mood",
              "humorMechanism", "printMethod", "garmentStyle", "designEra", "backgroundTreatment",
            ],
            additionalProperties: false,
          },
        },
      },
    });

    const raw = response.choices?.[0]?.message?.content;
    const text = typeof raw === "string" ? raw : null;
    if (!text) return null;

    return JSON.parse(text) as SourceStyleJSON;
  } catch (err) {
    console.warn("[StyleExtractor] Extraction failed (non-fatal):", err);
    return null;
  }
}
