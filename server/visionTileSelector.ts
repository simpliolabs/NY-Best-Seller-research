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
You do NOT read or extract URLs from images. URLs are provided separately in the structured input. You judge whether each tile shows a graphic t-shirt design AND — per the NICHE CONTEXT below — whether it has a clean, easy conversion to the niche (the CONVERTIBILITY GATE). Both must be true to select.

=== OUTPUT RULES ===
- For EACH tile you select, return its listing ID AND a one-sentence \`conversion\`: the EXACT single-step swap that makes it niche — e.g. "write DINK on the can the raccoon holds", "swap the frog for a llama in the same pose/outfit", "change the score 567.9 to 0-0-2". If you cannot write a concrete, specific one-step conversion, you are NOT allowed to select the tile. A vague conversion ("make it pickleball themed", "add pickleball elements") is NOT a conversion — reject the tile.
- Select 0 to 6 tiles per batch. Returning ZERO is a great and common answer — most batches contain few or no clean fits. There is NO minimum and NO quota; never select a marginal tile to "fill" the batch.
- Be RUTHLESS. Every tile you pass downstream costs real money: a vision-brain reasoning call AND an image generation. A bad-fit selection wastes both AND produces a junk product. When you are anything less than confident the conversion is clean and obvious, REJECT.`;

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
    "",
    "★ CONVERTIBILITY GATE (the decisive test — select ONLY designs that are EASY to convert):",
    "You are given HIGH-DETAIL images — actually READ the text and inspect the subject. Select a",
    "tile ONLY if it has an OBVIOUS, CLEAN, one-step conversion to the niche, of one of these kinds:",
    "  - TEXT / NUMBER / PUN swap (for TEXT-DRIVEN designs): read the design's words; it qualifies if",
    "    a single number/word swap or a structure-preserving pun makes it niche text — e.g. a score",
    "    '567.9' → '0-0-2', or 'VELOCIREADER' → 'VELOCIDINKER'. If you cannot read a clean swap in the",
    "    text, it does NOT qualify on text grounds.",
    "  - MASCOT swap (for ANIMAL/CHARACTER designs): the main subject is an animal/character that can",
    "    become an on-brand mascot in the SAME pose/outfit/props/text (e.g. a cowboy frog → a cowboy",
    "    llama). This qualifies EVEN IF no niche equipment is added — the mascot swap is the conversion.",
    "  - OBJECT swap: a prominent object becomes a niche object (e.g. a moon → a pickleball).",
    "REJECT (no clean conversion — common and correct) if making it niche would need inventing a new",
    "scene, overlaying a generic niche theme on an unrelated design, or any forced/awkward stretch.",
    "★ SPECIFICALLY REJECT — DECORATIVE-MOTIF + LIFESTYLE-TEXT designs: an inspirational/lifestyle",
    "  phrase set over an unrelated decorative illustration (dandelion, florals, feathers, butterflies,",
    "  mountains, sunsets, waves, trees). Swapping the phrase to a niche pun leaves NICHE WORDS ON",
    "  UNRELATED ART = incoherent. Example failure: a dandelion 'just breathe' tee → 'Find Your Dink",
    "  Center' is NOT a clean fit — the dandelion has nothing to do with the niche, so the result reads",
    "  as a yoga design with odd text. A TEXT/word swap is clean ONLY when the design is TEXT-DRIVEN",
    "  (typography is the hero on a plain/neutral background) OR the imagery itself is niche-convertible.",
    "Most tiles will fail this gate — that is fine. Only pass the genuinely easy ones.",
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
        selections: {
          type: "array",
          description: "Tiles selected. Each REQUIRES a concrete one-step conversion; if you can't name one, don't include the tile.",
          items: {
            type: "object",
            properties: {
              listingId: { type: "string", description: "Listing ID of the selected tile" },
              conversion: {
                type: "string",
                description: "The EXACT single-step swap that makes this tile niche (e.g. 'write DINK on the can', 'swap frog for llama in same pose'). Must be concrete — vague themes are not allowed.",
              },
            },
            required: ["listingId", "conversion"],
            additionalProperties: false,
          },
        },
        rejectionNotes: {
          type: "string",
          description: "Brief note on why rejected tiles were excluded (for logging)",
        },
      },
      required: ["selections", "rejectionNotes"],
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
    ? ` Target niche for downstream adaptation: "${nicheContext.niche}". Per the NICHE CONTEXT + CONVERTIBILITY GATE below, select ONLY tiles for which you can name a concrete one-step conversion. Selecting zero is fine.`
    : "";

  const userText = `Here are ${candidates.length} Etsy search result tiles from the "${category}" category. For each tile I provide: the listing ID, title, and the product thumbnail image.

Select which tiles show GRAPHIC T-SHIRT DESIGNS suitable for print-on-demand pattern extraction. Reject digital downloads, non-apparel, unclear images, and generic undesigned text. Typography-driven designs with stylistic treatment ARE valid — select them.${nicheNote}

For every tile you select you MUST provide its \`conversion\` — the exact one-step swap that makes it niche. If you can't name one, don't select it. No quota: returning zero selections is a good answer when nothing is a clean fit.

Tiles:
${candidates.map((c, i) => `[${i + 1}] ID: ${c.listingId} | Title: "${c.title}"`).join("\n")}

Return your selections as JSON: each selected tile's listingId AND its concrete one-step conversion, plus brief rejectionNotes.`;

  const imageBlocks: MessageContent[] = candidates.map((c) => ({
    type: "image_url" as const,
    // detail:high (was low) — the selector now judges CONVERTIBILITY, which requires
    // READING the design's text (number/word/pun swaps like 567.9→0-0-2,
    // VELOCIREADER→VELOCIDINKER). Low detail can't reliably read text. Use the
    // full-res image when available so text is legible; fall back to thumbnail.
    image_url: { url: c.fullResUrl || c.thumbnailUrl, detail: "high" as const },
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
    let parsed: { selections: Array<{ listingId: string; conversion: string }>; rejectionNotes: string };
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`LLM returned malformed JSON: ${raw.slice(0, 200)}`);
    }

    if (!Array.isArray(parsed.selections)) {
      throw new Error(`selections is not an array: ${raw.slice(0, 200)}`);
    }

    // Keep only tiles with a real ID AND a concrete conversion (a named one-step swap
    // is REQUIRED to select — drop any selection missing/empty conversion).
    const validSelections = parsed.selections
      .filter((s) => s && candidateIdSet.has(s.listingId) && typeof s.conversion === "string" && s.conversion.trim().length > 0)
      .slice(0, 6);
    const validIds = validSelections.map((s) => s.listingId);

    // Log the named conversion for each pick — accountability + debuggability.
    if (validSelections.length) {
      console.log(
        `[VisionTileSelector] "${category}" selected ${validIds.length}: ` +
          validSelections.map((s) => `${s.listingId} → ${s.conversion}`).join(" | ")
      );
    }

    return { selectedIds: validIds, rejectionNotes: parsed.rejectionNotes ?? "" };
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
