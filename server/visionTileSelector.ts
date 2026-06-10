/**
 * visionTileSelector.ts
 *
 * Selects graphic t-shirt tiles via a single constructive SCOUT that evaluates each
 * candidate against the PO's 5 questions — can it work / which concept / what kind of
 * edit / does it need text / Etsy virality — and selects every genuinely usable tile.
 * Replaces the old 3-seat reject-by-default council (Skeptic/Visionary/Judge) that turned
 * ~100 scraped tiles into ~2 selections (PO 2026-06-10: "out of 100+ I'd have used 40 by
 * asking the simple questions the council needs to ask").
 *
 * Pipeline per batch:
 *   Stage 1 — Shortlist (cheap, LOW detail): drop obvious non-candidates (~36 -> <=10).
 *   Stage 2 — Scout (HIGH detail): per tile answer the 5 questions; CODE selects on
 *             canWork && a real KB concept && virality >= med. Quality lives in the honest
 *             Q1 (can it work) + Q5 (virality) answers — NOT in default-rejecting anything
 *             that isn't trivially obvious. Downstream nicheExpertPlan.canConvert + the
 *             post-generation validator are the backstops.
 *
 * Exported surface (unchanged for callers):
 *   selectGraphicTeeTiles(category, candidates, nicheContext?) -> { selectedIds, rejectionNotes }
 */

import { invokeLLM, type MessageContent } from "./_core/llm";
import type { EtsyTile } from "./etsyScraper";

/**
 * Optional niche context — when provided, the Scout PREFERS tiles whose subject/typography
 * fits the niche and marks the genuinely non-transferable failure modes as canWork=false.
 */
export type NicheContext = {
  niche?: string;
  mascots?: string[];
  catchphrases?: string[];
};

// Shortlist cap — how many tiles enter the (expensive, high-detail) Scout pass.
const SHORTLIST_CAP = 10;
// Final cap — max selections returned per batch (no quota; zero is fine). The per-scan
// (20) and per-category (10) caps in nicheHunter.ts govern total cost downstream.
const FINAL_CAP = 6;

// ─── Shared niche-context block ──────────────────────────────────────────────────
/**
 * Build a niche-aware block: the workspace mascots/catchphrases + PREFER guidance + the
 * genuinely-non-transferable cases (the ONLY canWork=false reasons). Empty when no useful
 * context. NOTE: the old hard "CONVERTIBILITY GATE / decorative-motif default-reject" was
 * removed (PO 2026-06-10) — convertibility is now decided CONSTRUCTIVELY by the Scout's
 * Q1/Q5, not by rejecting anything that isn't a trivially-clean one-step swap.
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
    "PREFER (weight these higher when judging virality):",
    "- Subjects from the mascot list above, OR animals/characters visually adjacent to them",
    "  (same 'energy' — raccoons + cats + opossums + foxes all read as quirky-animal mascots).",
    "- Strong TRANSFERABLE STRUCTURE — a pose/count/arrangement another subject can drop into.",
    "- Typography that would carry a niche catchphrase or pun.",
    "(The genuinely-non-transferable cases that force canWork=false are defined in the Scout's Q1.)",
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
    console.warn(`[Scout:${label}] first attempt failed:`, firstErr);
    try {
      return await attempt();
    } catch (secondErr) {
      console.error(`[Scout:${label}] both attempts failed:`, secondErr);
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
    `You are the FAST FIRST-PASS FILTER for a print-on-demand pipeline that converts Etsy bestsellers into ${niche} designs. A Scout judges true fit AFTER you — your ONLY job is to cheaply drop the obvious non-candidates so the Scout isn't wasted on junk.

KEEP a tile only if BOTH hold:
- It shows a REAL graphic garment (t-shirt/hoodie/sweatshirt/tank) with a visible printed design — NOT a digital download / PNG / SVG mockup, NOT non-apparel (mug/sticker/tumbler/case), NOT blurry or obscured.
- It has at least a PLAUSIBLE hook to become ${niche}: an animal/character that could be swapped to a mascot, readable text that could be swapped, or a prop that could be relabeled.

Be GENEROUS here (the Scout rigorously judges fit next) but DROP: digital downloads, non-apparel, unclear images, plain undesigned system-font text, and tiles with NO plausible ${niche} hook at all.
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

// ─── Stage 2: the constructive Scout (replaces Skeptic/Visionary/Judge) ──────────

type ScoutEval = {
  listingId: string;
  canWork: boolean;
  concept: string;
  editType: "image-swap" | "text-swap" | "both" | "scene" | "none";
  needsText: boolean;
  viral: "high" | "med" | "low";
  conversion: string;
};

async function runScout(
  category: string,
  shortlist: EtsyTile[],
  nicheBlock: string,
  niche: string
): Promise<ScoutEval[]> {
  const system =
    `You are THE SCOUT for a print-on-demand pipeline that turns Etsy bestsellers into ${niche} designs. You are CONSTRUCTIVE — your job is to FIND every tile a skilled ${niche} designer could convert into a sellable design, NOT to hunt for reasons to reject. A good designer converts a large share of bestsellers; match that eye. Quality is held by your HONEST answers to Q1 and Q5 — not by rejecting anything that is not trivially obvious.

For EACH tile, answer 5 questions:
1. canWork (true/false) — CAN this become a ${niche} design? Say TRUE generously whenever ANY workable path exists: an animal/character to swap to a ${niche} mascot, text/number to swap to a ${niche} word/pun, a prop to relabel, an object to swap, OR a scene/grid whose activities can be re-themed to ${niche}. Say FALSE ONLY for genuinely non-transferable tiles: (a) costume gimmicks where the joke IS the costume (3D body-illusions, fake muscle/torso/hairy-chest, full-shirt photo overlays); (b) a specific historical/political moment or named figure (Washington crossing the Delaware, a presidential portrait, military insignia) whose cultural weight is non-transferable; (c) a niche pun set over UNRELATED decorative art (a dandelion/florals/mountains carrying a lifestyle phrase) where swapping ONLY the text leaves niche words on unrelated art — that is canWork=false (or viral='low'), UNLESS the imagery itself can be re-themed to ${niche}.
2. concept — WHICH specific ${niche} concept fits THIS tile best? Name a real mascot / catchphrase / inside-joke / pun from the niche context. If canWork is true you MUST name one; use "" ONLY when canWork is false.
3. editType — how it converts: "image-swap" (swap the subject/mascot), "text-swap" (swap the words/number), "both", "scene" (re-theme the activities/props of a scene or grid), or "none".
4. needsText — does it need a ${niche} pun/word ADDED to read as ${niche} (true), or is the niche carried by the swapped subject/props alone (false)? (Two hugging animals need an added pun; a mascot mid-game holding a paddle does not.)
5. viral — would this read as a scroll-stopping, on-trend ${niche} tee a fan would actually BUY? "high" = a strong hook/joke; "med" = solid and sellable; "low" = weak, generic, forced, or incoherent.

Also give conversion: ONE concrete sentence describing the exact ${niche} design to build (the swap + the concept + any added pun text), for the generator.

Be honest, not harsh: a tile that needs a clean mascot-swap PLUS an added pun is a GOOD candidate (canWork=true, viral med/high), not a reject. Only a true no-path (canWork=false) or a genuinely weak result (viral=low) should fall out.` + nicheBlock;

  const userText = `Scout these ${shortlist.length} tiles from the "${category}" category. Answer all 5 questions for EVERY tile. The tile images follow in the SAME order.\n\nTiles:\n${tileLines(shortlist)}`;

  const schema = {
    type: "object",
    properties: {
      evaluations: {
        type: "array",
        items: {
          type: "object",
          properties: {
            listingId: { type: "string" },
            canWork: { type: "boolean" },
            concept: { type: "string", description: "The KB concept that fits, or empty string if canWork is false" },
            editType: { type: "string", enum: ["image-swap", "text-swap", "both", "scene", "none"] },
            needsText: { type: "boolean" },
            viral: { type: "string", enum: ["high", "med", "low"] },
            conversion: { type: "string", description: "One concrete sentence: the exact niche design to build" },
          },
          required: ["listingId", "canWork", "concept", "editType", "needsText", "viral", "conversion"],
          additionalProperties: false,
        },
      },
    },
    required: ["evaluations"],
    additionalProperties: false,
  };

  const userContent: MessageContent[] = [
    { type: "text" as const, text: userText },
    ...imageBlocks(shortlist, "high"),
  ];
  const parsed = await invokeJSON<{ evaluations: ScoutEval[] }>(system, userContent, schema, "scout_evaluations", "scout");
  return parsed?.evaluations ?? [];
}

// ─── Main export — orchestrate shortlist -> Scout ────────────────────────────────

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
    console.log(`[Scout] "${category}" shortlist empty — no plausible candidates`);
    return { selectedIds: [], rejectionNotes: "Shortlist empty — no plausible candidates" };
  }
  console.log(`[Scout] "${category}" shortlist: ${shortlist.length}/${candidates.length} -> scouting`);

  // Stage 2 — the Scout answers the PO's 5 questions per tile; CODE applies the rule.
  const evals = await runScout(category, shortlist, nicheBlock, niche);
  if (evals.length === 0) {
    console.error(`[Scout] "${category}" scout returned nothing — selecting nothing (safe default)`);
    return { selectedIds: [], rejectionNotes: "Scout returned no evaluations" };
  }

  // SELECT (PO's 5 questions): can work + names a real concept + virality >= med.
  const seen = new Set<string>();
  const selected = evals.filter((e) => {
    if (!e || e.canWork !== true || !candidateIdSet.has(e.listingId)) return false;
    if (typeof e.concept !== "string" || e.concept.trim().length === 0) return false;
    if (e.viral !== "high" && e.viral !== "med") return false;
    if (typeof e.conversion !== "string" || e.conversion.trim().length === 0) return false;
    if (seen.has(e.listingId)) return false; // de-dup hallucinated repeats
    seen.add(e.listingId);
    return true;
  });
  // Highest-virality first so the FINAL_CAP keeps the strongest.
  const viralRank: Record<ScoutEval["viral"], number> = { high: 0, med: 1, low: 2 };
  selected.sort((a, b) => viralRank[a.viral] - viralRank[b.viral]);
  const valid = selected.slice(0, FINAL_CAP);

  for (const e of valid) {
    console.log(
      `[Scout] "${category}" SELECT ${e.listingId} -> ${e.conversion} | viral=${e.viral} edit=${e.editType} needsText=${e.needsText}`
    );
  }
  const canWorkFalse = evals.filter((e) => !e.canWork).length;
  const viralLow = evals.filter((e) => e.viral === "low").length;
  console.log(
    `[Scout] "${category}" final: ${valid.length} selected from ${shortlist.length} scouted (${canWorkFalse} canWork=false, ${viralLow} viral=low)`
  );

  const notes = `Scout: ${valid.length}/${shortlist.length} selected (canWork + concept + viral>=med); ${canWorkFalse} no-path, ${viralLow} low-virality.`;
  return { selectedIds: valid.map((e) => e.listingId), rejectionNotes: notes };
}
