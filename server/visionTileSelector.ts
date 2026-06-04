/**
 * visionTileSelector.ts
 *
 * Calls the Vision LLM to select graphic t-shirt tiles from Etsy search results.
 * Typography-driven designs ARE valid sources (per v2.1 approved plan §5A).
 *
 * Exported surface:
 *   selectGraphicTeeTiles(category, candidates) → string[] (selected listingIds)
 */

import { invokeLLM, type MessageContent } from "./_core/llm";
import type { EtsyTile } from "./etsyScraper";

// ─── Prompts (verbatim from §5A of approved plan v2.1) ───────────────────────

const SYSTEM_PROMPT = `You are a print-on-demand product classifier. Your ONLY job is to look at Etsy search result tiles and decide which ones show GRAPHIC T-SHIRT DESIGNS that are suitable for design pattern extraction.

=== WHAT TO SELECT ===
- Physical t-shirts, hoodies, sweatshirts, or tank tops with a visible printed graphic design
- The graphic must be clearly visible in the product photo (not just a title claiming "graphic tee")
- Must show an actual garment (flat lay, model wearing, or hanger shot) — not a digital mockup of a PNG file
- Typography-driven designs with stylized, distressed, retro, or hand-lettered text — these ARE valid sources, even with no illustration. Select them if the text treatment shows deliberate design craft (custom fonts, distressing, retro styling, creative layout, hand-drawn lettering)
- Designs that combine typography with minimal graphic elements (icons, borders, banners, small illustrations framing the text)

=== WHAT TO REJECT ===
- Digital downloads (SVG, PNG, sublimation files) — these show the artwork on a white/transparent background, not on a real shirt
- Mugs, tumblers, stickers, phone cases, or any non-apparel item
- Shirts where the design is not clearly visible (too small, blurry, or obscured by folding)
- Custom/personalized products where the design is a template with placeholder text (e.g., "YOUR NAME HERE")
- Text designs using generic, undesigned system-font output (plain Arial/Helvetica with no stylistic treatment) — only reject these, NOT stylized typography

=== CRITICAL NON-GOAL ===
You do NOT read or extract URLs from images. URLs are provided separately in the structured input. You ONLY judge whether each tile shows a graphic t-shirt design.

=== OUTPUT RULES ===
- Return ONLY the listing IDs of tiles you select
- Select between 2 and 6 tiles per batch (aim for quality over quantity)
- If fewer than 2 tiles qualify, return an empty array — do NOT lower your standards
- If you are uncertain about a tile, reject it (false negatives are acceptable; false positives waste downstream LLM calls)`;

// ─── Response schema ──────────────────────────────────────────────────────────

const RESPONSE_FORMAT = {
  type: "json_schema" as const,
  json_schema: {
    name: "tile_selections",
    strict: true,
    schema: {
      type: "object",
      properties: {
        selectedListingIds: {
          type: "array",
          items: { type: "string" },
          description: "Listing IDs of tiles that show graphic t-shirt designs",
        },
        rejectionNotes: {
          type: "string",
          description: "Brief note on why rejected tiles were excluded (for logging)",
        },
      },
      required: ["selectedListingIds", "rejectionNotes"],
      additionalProperties: false,
    },
  },
};

// ─── Main export ──────────────────────────────────────────────────────────────

export async function selectGraphicTeeTiles(
  category: string,
  candidates: EtsyTile[]
): Promise<{ selectedIds: string[]; rejectionNotes: string }> {
  if (candidates.length === 0) {
    return { selectedIds: [], rejectionNotes: "No candidates provided" };
  }

  const candidateIdSet = new Set(candidates.map((c) => c.listingId));

  const userText = `Here are ${candidates.length} Etsy search result tiles from the "${category}" category. For each tile I provide: the listing ID, title, and the product thumbnail image.

Select which tiles show GRAPHIC T-SHIRT DESIGNS suitable for print-on-demand pattern extraction. Reject digital downloads, non-apparel, unclear images, and generic undesigned text. Typography-driven designs with stylistic treatment ARE valid — select them.

Tiles:
${candidates.map((c, i) => `[${i + 1}] ID: ${c.listingId} | Title: "${c.title}"`).join("\n")}

Return your selections as a JSON array of listing IDs.`;

  const imageBlocks: MessageContent[] = candidates.map((c) => ({
    type: "image_url" as const,
    image_url: { url: c.thumbnailUrl, detail: "low" as const },
  }));

  const invokeAndParse = async (): Promise<{ selectedIds: string[]; rejectionNotes: string }> => {
    const response = await invokeLLM({
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: [{ type: "text" as const, text: userText }, ...imageBlocks] as MessageContent[],
        },
      ],
      response_format: RESPONSE_FORMAT,
    });

    const contentVal = response.choices?.[0]?.message?.content ?? "";
    const raw = typeof contentVal === "string" ? contentVal : JSON.stringify(contentVal);
    let parsed: { selectedListingIds: string[]; rejectionNotes: string };
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`LLM returned malformed JSON: ${raw.slice(0, 200)}`);
    }

    if (!Array.isArray(parsed.selectedListingIds)) {
      throw new Error(`selectedListingIds is not an array: ${raw.slice(0, 200)}`);
    }

    // Filter out hallucinated IDs (IDs not in the input set)
    const validIds = parsed.selectedListingIds.filter((id) => candidateIdSet.has(id));

    // Cap at 6 per plan
    const cappedIds = validIds.slice(0, 6);

    return { selectedIds: cappedIds, rejectionNotes: parsed.rejectionNotes ?? "" };
  };

  // Attempt with one retry on failure
  try {
    return await invokeAndParse();
  } catch (firstErr) {
    console.warn(`[VisionTileSelector] First attempt failed for "${category}":`, firstErr);
    try {
      return await invokeAndParse();
    } catch (secondErr) {
      console.error(`[VisionTileSelector] Both attempts failed for "${category}":`, secondErr);
      return { selectedIds: [], rejectionNotes: `LLM error after 2 attempts: ${String(secondErr)}` };
    }
  }
}
