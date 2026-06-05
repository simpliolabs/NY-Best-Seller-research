/**
 * visionTileSelector.ts
 *
 * Calls the Vision LLM to select graphic t-shirt tiles from Etsy search results.
 * Typography-driven designs ARE valid sources (per v2.1 approved plan §5A).
 *
 * Exported surface:
 *   selectGraphicTeeTiles(category, candidates, nicheContext?) → string[] (selected listingIds)
 */

import { invokeLLM, type MessageContent } from "./_core/llm";
import type { EtsyTile } from "./etsyScraper";

/**
 * Optional niche context — when provided, the selector PREFERS tiles whose
 * subject/typography fits the niche, and REJECTS off-niche failure modes
 * (costume gimmicks, historical-figure designs) that pass the generic
 * "is-this-a-graphic-tee" filter but waste downstream brain/image-gen budget.
 */
export type NicheContext = {
  niche?: string;
  mascots?: string[];
  catchphrases?: string[];
};

// ─── Prompts (verbatim from §5A of approved plan v2.1) ───────────────────────

const BASE_SYSTEM_PROMPT = `You are a print-on-demand product classifier. Your ONLY job is to look at Etsy search result tiles and decide which ones show GRAPHIC T-SHIRT DESIGNS that are suitable for design pattern extraction.

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

/**
 * Build a niche-aware addition to the base system prompt. Adds PREFER + ALSO REJECT
 * blocks calibrated to the workspace's mascots/catchphrases, so the selector chooses
 * niche-fit tiles over equally-valid-graphic-tee-but-off-brand ones. Returns empty
 * string when no useful context is provided (degrades gracefully).
 */
function buildNicheBlock(ctx: NicheContext | undefined): string {
  if (!ctx) return "";
  const niche = (ctx.niche ?? "").trim();
  const mascots = (ctx.mascots ?? []).filter(Boolean).slice(0, 8);
  const catchphrases = (ctx.catchphrases ?? []).filter(Boolean).slice(0, 6);
  if (!niche && mascots.length === 0 && catchphrases.length === 0) return "";

  const lines: string[] = ["", "=== NICHE CONTEXT ==="];
  if (niche) lines.push(`Niche: ${niche}`);
  if (mascots.length) lines.push(`On-brand mascots/subjects: ${mascots.join(", ")}.`);
  if (catchphrases.length) lines.push(`Niche catchphrases/phrases: ${catchphrases.join(", ")}.`);
  lines.push(
    "",
    "PREFER (within qualifying tiles, weight these higher):",
    "- Subjects from the mascot list above, OR animals/characters visually adjacent",
    "  to them (same 'energy' — e.g. raccoons + cats + opossums + foxes all read as",
    "  quirky-animal mascots).",
    "- Typography that matches the niche voice (irreverent quips, vintage lockup",
    "  treatments that would adapt to the niche's catchphrases).",
    "- Designs with strong TRANSFERABLE STRUCTURE — pose, count, arrangement that",
    "  another subject could be dropped into (e.g. '3 figures running in a row' is a",
    "  reusable composition).",
    "",
    "ALSO REJECT:",
    "- Costume gimmicks where the joke IS the costume: 3D-printed full-shirt body",
    "  illusions (fake hairy chest, fake muscle suit, fake torso, full-shirt photo",
    "  overlays). The punchline is 'the wearer becomes the costume' and does not",
    "  transfer to any other subject.",
    "- Designs locked to a specific historical/political moment or named figure",
    "  (e.g., Washington crossing the Delaware, presidential portraits, military",
    "  insignia). The cultural weight is non-transferable to most niches.",
    "=== END NICHE CONTEXT ===",
  );
  return lines.join("\n");
}

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
  candidates: EtsyTile[],
  nicheContext?: NicheContext
): Promise<{ selectedIds: string[]; rejectionNotes: string }> {
  if (candidates.length === 0) {
    return { selectedIds: [], rejectionNotes: "No candidates provided" };
  }

  const candidateIdSet = new Set(candidates.map((c) => c.listingId));
  const systemPrompt = BASE_SYSTEM_PROMPT + buildNicheBlock(nicheContext);
  const nicheNote = nicheContext?.niche
    ? ` Target niche for downstream adaptation: "${nicheContext.niche}". When more than 6 tiles qualify, PREFER the ones with the strongest niche-fit per the NICHE CONTEXT block above.`
    : "";

  const userText = `Here are ${candidates.length} Etsy search result tiles from the "${category}" category. For each tile I provide: the listing ID, title, and the product thumbnail image.

Select which tiles show GRAPHIC T-SHIRT DESIGNS suitable for print-on-demand pattern extraction. Reject digital downloads, non-apparel, unclear images, and generic undesigned text. Typography-driven designs with stylistic treatment ARE valid — select them.${nicheNote}

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
        { role: "system", content: systemPrompt },
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
