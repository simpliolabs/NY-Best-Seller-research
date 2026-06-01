/**
 * Mockup Color Matcher — Phase H
 * Uses LLM vision to analyze a design image and pick the best-matching
 * shirt colors from available mockup templates.
 * Karpathy: one function, structured JSON output, no over-abstraction.
 */
import { invokeLLM } from "./_core/llm";
import type { MockupTemplate } from "../drizzle/schema";

const COLOR_MATCH_SYSTEM = `You are a product designer selecting shirt blank colors for a t-shirt design.
Given a design image and a list of available shirt colors (name + hex), pick the best matches.

Selection criteria:
1. Contrast: The design must be clearly visible against the shirt color
2. Harmony: Colors should complement, not clash with the design palette
3. Commercial appeal: Popular colors (black, white, navy) should be preferred when they work
4. Variety: Include a mix of light and dark options when possible

Return a JSON array of the selected color names in order of best match.`;

export async function pickBestColors(
  designImageUrl: string,
  templates: MockupTemplate[],
  count: number
): Promise<MockupTemplate[]> {
  if (templates.length <= count) return templates;

  const colorList = templates
    .map((t) => `- ${t.colorName} (${t.colorHex})`)
    .join("\n");

  const response = await invokeLLM({
    messages: [
      { role: "system", content: COLOR_MATCH_SYSTEM },
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: designImageUrl } },
          {
            type: "text",
            text: `Available shirt colors:\n${colorList}\n\nPick the ${count} best-matching colors for this design. Return ONLY a JSON array of color names.`,
          },
        ],
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "color_picks",
        strict: true,
        schema: {
          type: "object",
          properties: {
            colors: {
              type: "array",
              items: { type: "string" },
              description: "Ordered list of selected color names",
            },
          },
          required: ["colors"],
          additionalProperties: false,
        },
      },
    },
  });

  const content = (response.choices[0]?.message?.content ?? "{}") as string;
  let parsed: { colors: string[] };
  try {
    parsed = JSON.parse(content);
  } catch {
    // Fallback: return first N templates
    return templates.slice(0, count);
  }

  // Map color names back to templates, preserving order
  const selected: MockupTemplate[] = [];
  for (const colorName of parsed.colors) {
    const match = templates.find(
      (t) => t.colorName.toLowerCase() === colorName.toLowerCase()
    );
    if (match && !selected.includes(match)) {
      selected.push(match);
    }
    if (selected.length >= count) break;
  }

  // If LLM returned fewer than requested, pad with remaining templates
  if (selected.length < count) {
    for (const t of templates) {
      if (!selected.includes(t)) selected.push(t);
      if (selected.length >= count) break;
    }
  }

  return selected;
}
