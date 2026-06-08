/**
 * visionTileSelector.ts
 *
 * Selects graphic t-shirt tiles via a 3-member COUNCIL that debates each candidate,
 * then a Judge rules. Replaces the old single lenient pass that kept selecting bad
 * fits (PO: "images that are not the right fit are selected, then it wastes tokens").
 *
 * Pipeline per batch (token-bounded ~4 calls):
 *   Stage 1 — Shortlist (cheap, LOW detail): drop obvious non-candidates so the
 *             expensive debate only judges plausible tiles (~36 tiles → ≤10).
 *   Stage 2 — Council (HIGH detail, on the shortlist):
 *               • The Skeptic   (adversarial) — names why each tile is a BAD fit.
 *               • The Visionary (optimist)    — finds the cleverest CLEAN one-step swap, or "none".
 *               • The Judge     (pragmatic)   — final call per tile; defaults to the Skeptic when unsure.
 * Each seat is a separate LLM call with its own role prompt ("trained separately").
 *
 * Exported surface (unchanged for callers):
 *   selectGraphicTeeTiles(category, candidates, nicheContext?) → { selectedIds, rejectionNotes }
 */

import { invokeLLM, type MessageContent } from "./_core/llm";
import type { EtsyTile } from "./etsyScraper";

/**
 * Optional niche context — when provided, every council seat PREFERS tiles whose
 * subject/typography fits the niche and REJECTS off-niche failure modes (costume
 * gimmicks, historical-figure designs, decorative-motif overlays).
 */
export type NicheContext = {
  niche?: string;
  mascots?: string[];
  catchphrases?: string[];
};

// Shortlist cap — how many tiles enter the (expensive, high-detail) council debate.
const SHORTLIST_CAP = 10;
// Final cap — max selections returned per batch (no quota; zero is fine).
const FINAL_CAP = 6;

// ─── Shared niche-context block (used by every seat) ─────────────────────────────
/**
 * Build a niche-aware block with PREFER + REJECT guidance + the CONVERTIBILITY GATE,
 * calibrated to the workspace's mascots/catchphrases. Empty when no useful context.
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
    "★ CONVERTIBILITY GATE (the decisive test — only tiles with an EASY, CLEAN conversion qualify):",
    "Read the text and inspect the subject. A tile qualifies ONLY if it has an OBVIOUS, CLEAN,",
    "one-step conversion to the niche, of one of these kinds:",
    "  - TEXT / NUMBER / PUN swap (for TEXT-DRIVEN designs): a single number/word swap or a",
    "    structure-preserving pun makes it niche text — e.g. a score '567.9' → '0-0-2', or",
    "    'VELOCIREADER' → 'VELOCIDINKER'. If you cannot read a clean swap, it does NOT qualify on text.",
    "  - MASCOT swap (for ANIMAL/CHARACTER designs): the main subject is an animal/character that can",
    "    become an on-brand mascot in the SAME pose/outfit/props/text (e.g. a cowboy frog → a cowboy",
    "    llama). Qualifies EVEN IF no niche equipment is added — the mascot swap is the conversion.",
    "  - PROP RELABEL: the subject holds/wears/displays a writable surface (can, cup, bottle, sign,",
    "    jersey, ball, book) — write the niche word/logo ON that surface, changing nothing else.",
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
    "=== END NICHE CONTEXT ===",
  );
  return lines.join("\n");
}

// ─── Low-level helpers ───────────────────────────────────────────────────────────

function imageBlocks(tiles: EtsyTile[], detail: "low" | "high"): MessageContent[] {
  return tiles.map((c) => ({
    type: "image_url" as const,
    image_url: { url: c.fullResUrl || c.thumbnailUrl, detail },
  }));
}

function tileLines(tiles: EtsyTile[]): string {
  return tiles.map((c, i) => `[${i + 1}] ID: ${c.listingId} | Title: "${c.title}"`).join("\n");
}

/**
 * Invoke the LLM with a strict JSON schema, parse the result, retry once on failure.
 * Returns the parsed object, or null if both attempts fail (caller decides the safe default).
 */
async function invokeJSON<T>(
  systemPrompt: string,
  userContent: MessageContent[],
  schema: Record<string, unknown>,
  schemaName: string,
  label: string
): Promise<T | null> {
  const response_format = {
    type: "json_schema" as const,
    json_schema: { name: schemaName, strict: true, schema },
  };
  const attempt = async (): Promise<T> => {
    const response = await invokeLLM({
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
      response_format,
    });
    const contentVal = response.choices?.[0]?.message?.content ?? "";
    const raw = typeof contentVal === "string" ? contentVal : JSON.stringify(contentVal);
    return JSON.parse(raw) as T;
  };
  try {
    return await attempt();
  } catch (firstErr) {
    console.warn(`[Council:${label}] first attempt failed:`, firstErr);
    try {
      return await attempt();
    } catch (secondErr) {
      console.error(`[Council:${label}] both attempts failed:`, secondErr);
      return null;
    }
  }
}

// ─── Stage 1: cheap low-detail shortlist ─────────────────────────────────────────

async function shortlistTiles(
  category: string,
  candidates: EtsyTile[],
  nicheBlock: string,
  niche: string
): Promise<EtsyTile[]> {
  const system =
    `You are the FAST FIRST-PASS FILTER for a print-on-demand pipeline that converts Etsy bestsellers into ${niche} designs. A 3-member council judges true fit AFTER you — your ONLY job is to cheaply drop the obvious non-candidates so the council isn't wasted on junk.

KEEP a tile only if BOTH hold:
- It shows a REAL graphic garment (t-shirt/hoodie/sweatshirt/tank) with a visible printed design — NOT a digital download / PNG / SVG mockup, NOT non-apparel (mug/sticker/tumbler/case), NOT blurry or obscured.
- It has at least a PLAUSIBLE hook to become ${niche}: an animal/character that could be swapped to a mascot, readable text that could be swapped, or a prop that could be relabeled.

Be GENEROUS here (the council rigorously judges fit next) but DROP: digital downloads, non-apparel, unclear images, plain undesigned system-font text, and tiles with NO plausible ${niche} hook at all.
Return at most ${SHORTLIST_CAP} listing IDs.` + nicheBlock;

  const userText = `Here are ${candidates.length} Etsy tiles from the "${category}" category. Each: listing ID + title + thumbnail. Return the shortlist of plausible candidates (max ${SHORTLIST_CAP}).\n\nTiles:\n${tileLines(candidates)}`;

  const schema = {
    type: "object",
    properties: {
      shortlistIds: {
        type: "array",
        items: { type: "string" },
        description: "Listing IDs that pass the cheap first filter",
      },
    },
    required: ["shortlistIds"],
    additionalProperties: false,
  };

  const userContent: MessageContent[] = [
    { type: "text" as const, text: userText },
    ...imageBlocks(candidates, "low"),
  ];
  const parsed = await invokeJSON<{ shortlistIds: string[] }>(system, userContent, schema, "tile_shortlist", "shortlist");
  // If the filter call failed outright, don't silently lose the batch — pass a capped slice.
  if (!parsed) return candidates.slice(0, SHORTLIST_CAP);
  const ids = new Set(parsed.shortlistIds ?? []);
  return candidates.filter((c) => ids.has(c.listingId)).slice(0, SHORTLIST_CAP);
}

// ─── Stage 2: the council ────────────────────────────────────────────────────────

type SkepticVerdict = { listingId: string; objection: string; recommendation: "reject" | "borderline" | "none" };
type VisionaryProposal = { listingId: string; conversion: string; cleanliness: "obvious" | "plausible" | "none" };

async function runSkeptic(
  category: string,
  shortlist: EtsyTile[],
  nicheBlock: string,
  niche: string
): Promise<SkepticVerdict[]> {
  const system =
    `You are THE SKEPTIC — the adversarial seat on a 3-member design council selecting Etsy tiles to convert into ${niche} designs. Assume every tile is a BAD fit until proven otherwise. Your job is to KILL bad fits so the pipeline doesn't waste a vision-brain call + an image generation producing junk.

For EACH tile, state the STRONGEST objection — the most likely reason it makes a POOR ${niche} conversion. Common failure modes:
- FORCED/AWKWARD: there is no clean ONE-STEP swap; making it ${niche} needs a stretch.
- DECORATIVE-MOTIF + LIFESTYLE-TEXT: a decorative illustration (dandelion, florals, feathers, mountains, sunset, waves, trees) with an inspirational phrase — swapping the phrase leaves ${niche} words on unrelated art (incoherent).
- OFF-BRAND SUBJECT: a subject/theme that doesn't fit ${niche} and isn't a swappable animal/character.
- INVENTION REQUIRED: converting needs adding a scene/prop/copy not in the source.
- OVER-EDIT RISK: the only way to convert is to redraw most of the design (the image model will mangle it).

recommendation: "reject" (objection is fatal), "borderline" (real objection but maybe surmountable), or "none" (you genuinely cannot find a real objection — this is rare). Be concrete per tile. Do NOT be charitable — that is the Visionary's job.` + nicheBlock;

  const userText = `Council case — "${category}" shortlist. Give your adversarial verdict for EVERY tile below (images follow in order).\n\nTiles:\n${tileLines(shortlist)}`;

  const schema = {
    type: "object",
    properties: {
      verdicts: {
        type: "array",
        items: {
          type: "object",
          properties: {
            listingId: { type: "string" },
            objection: { type: "string", description: "The strongest reason this tile is a bad fit" },
            recommendation: { type: "string", enum: ["reject", "borderline", "none"] },
          },
          required: ["listingId", "objection", "recommendation"],
          additionalProperties: false,
        },
      },
    },
    required: ["verdicts"],
    additionalProperties: false,
  };

  const userContent: MessageContent[] = [
    { type: "text" as const, text: userText },
    ...imageBlocks(shortlist, "high"),
  ];
  const parsed = await invokeJSON<{ verdicts: SkepticVerdict[] }>(system, userContent, schema, "skeptic_verdicts", "skeptic");
  return parsed?.verdicts ?? [];
}

async function runVisionary(
  category: string,
  shortlist: EtsyTile[],
  nicheBlock: string,
  niche: string
): Promise<VisionaryProposal[]> {
  const system =
    `You are THE VISIONARY — the optimist seat on a 3-member design council selecting Etsy tiles to convert into ${niche} designs. Your job is to find the SINGLE cleverest CLEAN one-step conversion for each tile, so genuine gems aren't wrongly rejected.

A CLEAN one-step conversion is EXACTLY one of:
- TEXT/NUMBER/PUN swap on a TEXT-DRIVEN design (e.g. score '567.9' → '0-0-2'; 'VELOCIREADER' → 'VELOCIDINKER').
- MASCOT swap: an animal/character → an on-brand mascot in the SAME pose/outfit/props/text (e.g. cowboy frog → cowboy llama). Valid even with no added equipment.
- PROP RELABEL: the subject holds/wears/displays a writable surface (can, cup, sign, jersey, ball) — write the ${niche} word/logo ON it, nothing else.
- OBJECT swap: a prominent object → a ${niche} object (moon → pickleball).

For each tile, propose the BEST such conversion in ONE concrete sentence, and rate cleanliness: "obvious" (dead-clean), "plausible" (workable), or "none" (NO genuinely clean one-step conversion exists — be honest, do NOT force one). A vague theme ("make it ${niche}") is "none".` + nicheBlock;

  const userText = `Council case — "${category}" shortlist. For EVERY tile below, give your best clean one-step conversion (or "none"). Images follow in order.\n\nTiles:\n${tileLines(shortlist)}`;

  const schema = {
    type: "object",
    properties: {
      proposals: {
        type: "array",
        items: {
          type: "object",
          properties: {
            listingId: { type: "string" },
            conversion: { type: "string", description: "The single cleverest clean one-step swap, or 'none'" },
            cleanliness: { type: "string", enum: ["obvious", "plausible", "none"] },
          },
          required: ["listingId", "conversion", "cleanliness"],
          additionalProperties: false,
        },
      },
    },
    required: ["proposals"],
    additionalProperties: false,
  };

  const userContent: MessageContent[] = [
    { type: "text" as const, text: userText },
    ...imageBlocks(shortlist, "high"),
  ];
  const parsed = await invokeJSON<{ proposals: VisionaryProposal[] }>(system, userContent, schema, "visionary_proposals", "visionary");
  return parsed?.proposals ?? [];
}

async function runJudge(
  category: string,
  shortlist: EtsyTile[],
  skeptic: SkepticVerdict[],
  visionary: VisionaryProposal[],
  nicheBlock: string,
  niche: string
): Promise<{ selections: Array<{ listingId: string; conversion: string }>; rejectionNotes: string } | null> {
  const dossier = shortlist
    .map((t) => {
      const sk = skeptic.find((v) => v.listingId === t.listingId);
      const vi = visionary.find((p) => p.listingId === t.listingId);
      return (
        `ID ${t.listingId} — "${t.title}"\n` +
        `  SKEPTIC (${sk?.recommendation ?? "n/a"}): ${sk?.objection ?? "no input"}\n` +
        `  VISIONARY (${vi?.cleanliness ?? "n/a"}): ${vi?.conversion ?? "no input"}`
      );
    })
    .join("\n\n");

  const system =
    `You are THE JUDGE — the pragmatic final arbiter of a 3-member design council selecting Etsy tiles to convert into ${niche} designs. You see each tile image, THE SKEPTIC's objection, and THE VISIONARY's proposed conversion.

SELECT a tile ONLY when BOTH hold:
- The Visionary found a GENUINELY clean one-step conversion (cleanliness "obvious", or a "plausible" you can confirm against the actual image), AND
- The Skeptic's objection does NOT hold up against the actual image.
DEFAULT TO THE SKEPTIC when uncertain. A rejected good tile costs nothing; a selected bad tile wastes a brain call + an image generation AND ships a junk product. There is NO quota — selecting ZERO is correct when nothing is clean.

For each tile you select, output its listingId and the EXACT conversion to use downstream (take the Visionary's if sound, or refine it to be more concrete). In rejectionNotes, briefly note who you sided with and why.` + nicheBlock;

  const userText = `Council dossier — "${category}" shortlist. The two seats have argued; you make the final call. The tile images follow in the SAME order as the dossier.\n\n${dossier}\n\nTiles (in order):\n${tileLines(shortlist)}`;

  const schema = {
    type: "object",
    properties: {
      selections: {
        type: "array",
        description: "Final selected tiles. Each REQUIRES a concrete one-step conversion.",
        items: {
          type: "object",
          properties: {
            listingId: { type: "string" },
            conversion: { type: "string", description: "The exact one-step swap to use downstream" },
          },
          required: ["listingId", "conversion"],
          additionalProperties: false,
        },
      },
      rejectionNotes: { type: "string", description: "Brief note on the final reasoning" },
    },
    required: ["selections", "rejectionNotes"],
    additionalProperties: false,
  };

  const userContent: MessageContent[] = [
    { type: "text" as const, text: userText },
    ...imageBlocks(shortlist, "high"),
  ];
  return invokeJSON<{ selections: Array<{ listingId: string; conversion: string }>; rejectionNotes: string }>(
    system,
    userContent,
    schema,
    "judge_selections",
    "judge"
  );
}

// ─── Main export — orchestrate the council ───────────────────────────────────────

export async function selectGraphicTeeTiles(
  category: string,
  candidates: EtsyTile[],
  nicheContext?: NicheContext
): Promise<{ selectedIds: string[]; rejectionNotes: string }> {
  if (candidates.length === 0) {
    return { selectedIds: [], rejectionNotes: "No candidates provided" };
  }

  const niche = ((nicheContext?.niche ?? "").trim()) || "the niche";
  const nicheBlock = buildNicheBlock(nicheContext);
  const candidateIdSet = new Set(candidates.map((c) => c.listingId));

  // Stage 1 — cheap low-detail shortlist (cull obvious non-candidates).
  const shortlist = await shortlistTiles(category, candidates, nicheBlock, niche);
  if (shortlist.length === 0) {
    console.log(`[Council] "${category}" shortlist empty — no plausible candidates`);
    return { selectedIds: [], rejectionNotes: "Shortlist empty — no plausible candidates" };
  }
  console.log(`[Council] "${category}" shortlist: ${shortlist.length}/${candidates.length} → debating`);

  // Stage 2 — Skeptic ∥ Visionary (parallel, independent), then the Judge rules.
  const [skeptic, visionary] = await Promise.all([
    runSkeptic(category, shortlist, nicheBlock, niche),
    runVisionary(category, shortlist, nicheBlock, niche),
  ]);
  const judged = await runJudge(category, shortlist, skeptic, visionary, nicheBlock, niche);
  if (!judged) {
    console.error(`[Council] "${category}" judge failed — selecting nothing (safe default)`);
    return { selectedIds: [], rejectionNotes: "Council judge failed — no selection" };
  }

  // Keep only real IDs with a concrete conversion; cap.
  const valid = (judged.selections ?? [])
    .filter((s) => s && candidateIdSet.has(s.listingId) && typeof s.conversion === "string" && s.conversion.trim().length > 0)
    .slice(0, FINAL_CAP);

  // Audit trail — log each surviving pick with the council's reasoning chain.
  for (const s of valid) {
    const sk = skeptic.find((v) => v.listingId === s.listingId);
    const vi = visionary.find((p) => p.listingId === s.listingId);
    console.log(
      `[Council] "${category}" SELECT ${s.listingId} → ${s.conversion} ` +
        `| skeptic=${sk?.recommendation ?? "n/a"} visionary=${vi?.cleanliness ?? "n/a"}`
    );
  }
  console.log(`[Council] "${category}" final: ${valid.length} selected from ${shortlist.length} debated`);

  return { selectedIds: valid.map((s) => s.listingId), rejectionNotes: judged.rejectionNotes ?? "" };
}
