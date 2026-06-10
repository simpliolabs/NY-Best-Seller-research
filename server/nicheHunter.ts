/**
 * Niche Hunter Scan Engine — Phase E + Style-Faithful Pipeline
 *
 * Five steps per scan:
 *   Step 1: Real Etsy hot sellers (scrape-based, no fallback)
 *   Step 1b: Style extraction from source images (Vision LLM per listing)
 *   Step 2: In-niche Reddit signal extraction (LLM analyzes niche subreddits)
 *   Steps 3+4: Pattern deconstruction + adaptation (LLM, cultural map aware)
 *   Step 5: Rank patterns (LLM, max 8 patterns per scan)
 *
 * Three-Mode Generation (per pattern):
 *   edit_source    — source image available + high-quality style JSON → edit with reference
 *   style_reference — source image available but style extraction failed → prompt with style hints
 *   prompt_only    — no source image → pure text prompt
 */

import { invokeLLM } from "./_core/llm";
import type { TextContent } from "./_core/llm";
import { generateImage } from "./_core/imageGeneration";
import { storagePut } from "./storage";
import { extractStyleFromImage } from "./styleExtractor";
import {
  openBrowser,
  closeBrowser,
  fetchEtsySearchPage,
  type EtsySearchFilter,
  type EtsyTile,
} from "./etsyScraper";
import { selectGraphicTeeTiles, type NicheContext } from "./visionTileSelector";
import type { SourceStyleJSON } from "../shared/sourceStyleJson";
import {
  createTrendPattern,
  updateScanRun,
  updateTrendPatternImage,
  updateTrendPatternScore,
  updateTrendPatternStatus,
  updateTrendPatternStyleData,
  updateTrendPatternConceptOptions,
  getTrendPatternsByWorkspace,
  recordRejectionSignal,
} from "./nicheHunterDb";
import { processPatternProduction, proposeConcepts, aggregateAvoidList } from "./patternProductionProcessor";
import { getProductGroupsByWorkspace } from "./productGroupDb";
import type { Workspace } from "../drizzle/schema";

// ─── Types ────────────────────────────────────────────────────────────────────

type AdaptationMode = "edit_source" | "style_reference" | "prompt_only";

type NicheProfile = {
  summary?: string;
  targetAudience?: string;
  subreddits?: string[];
  etsyKeywords?: string[];
  crossNicheCategories?: string[];
  /** General best-seller search terms for the product type this workspace sells (e.g. "funny shirt", "graphic tee") */
  generalBestSellerTerms?: string[];
  culturalMoments?: string[];
  designStyles?: string[];
  avoidTopics?: string[];
  culturalMap?: {
    animalMascots?: Array<{ animal: string; whyItWorks: string; visualTreatment: string }>;
    painPoints?: Array<{ pain: string; humorAngle: string }>;
    funPoints?: Array<{ joy: string; visualConcept: string }>;
    insideJokes?: Array<{ joke: string; context: string }>;
    physicalComedy?: Array<{ scenario: string; whyFunny: string }>;
    catchphrases?: string[];
    lifestyleIdentity?: Array<{ trait: string; purchaseDriver: string }>;
    rivalries?: Array<{ rivalry: string; tension: string; humorAngle: string }>;
    transferableVisualConcepts?: Array<{
      sourceNiche: string;
      sourcePattern: string;
      targetAdaptation: string;
      whyItTransfers: string;
    }>;
  };
};

// ─── Step 1: Real Etsy hot sellers (scrape-based, no API key, no LLM fallback) ─

interface HotSeller {
  title: string;
  category: string;
  estimatedSales: number;   // kept for downstream compatibility; set to reviewCount
  imageDescription: string; // kept for downstream compatibility; set to empty string
  sourceUrl?: string;
  sourceImageUrl?: string;
  sourceReviewCount?: number;
  sourceBadge?: string;
}

/** Source instrumentation — attached to scan for transparency */
export interface SourceInstrumentation {
  mode: "live_scrape" | "scraper_broken" | "zero_results";
  liveResultCount: number;
  categoriesSearched: number;
  httpErrors: { category: string; status: number; message: string }[];
  fallbackReason: string | null;
}

/**
 * Fetch real top-selling Etsy listings via web scraping.
 * Scrapes TWO pools:
 *   1. General Best Sellers — broad product-type terms (e.g. "funny shirt", "graphic tee")
 *      These represent what's hot in the GENERAL market for the product type being sold.
 *   2. Cross-Niche Inspiration — other niche markets (hiking, camping, yoga, etc.)
 *      These provide cross-pollination ideas from adjacent communities.
 *
 * NEVER fabricates data. If scraping yields 0, returns 0. No LLM fallback. No fiction.
 *
 * Two-pass strategy per category:
 *   Pass 1: is_best_seller filter
 *   Pass 2 (if pass 1 yields < 2 tiles per category): is_popular_now filter
 */
// Max total search categories per scan (general terms + cross-niche). Raised 5→8
// (PO 2026-06-08) so the scan covers more niches per run. Higher = more designs but
// slower scans (more Scrapfly fetches + image-gen).
const MAX_SCAN_CATEGORIES = 8;

async function fetchCrossNicheHotSellers(
  crossNicheCategories: string[],
  _etsyApiKey?: string,       // retained for signature compatibility; unused
  _etsyKeywords?: string[],
  generalBestSellerTerms?: string[],
  nicheContext?: NicheContext
): Promise<{ sellers: HotSeller[]; instrumentation: SourceInstrumentation; searchLog: Array<{ query: string; url: string; filter: "is_best_seller" | "is_popular_now"; resultCount: number; searchedAt: string }> }> {
  // Prepend general best-seller terms BEFORE cross-niche categories
  // Cap general terms at 2 (1-2 broad market searches, not the whole list)
  // Total category budget: MAX_SCAN_CATEGORIES (raised 5→8 per PO 2026-06-08 to cover
  // more niches per run; e.g. 2 general + 6 cross-niche). Trade-off: more Scrapfly
  // fetches + image-gen per run = slower scans. Paired with the per-category cap below.
  const generalTerms = (generalBestSellerTerms ?? []).slice(0, 2);
  const crossNiche = crossNicheCategories.slice(0, MAX_SCAN_CATEGORIES - generalTerms.length);
  const categories = [...generalTerms, ...crossNiche];
  const searchLog: Array<{ query: string; url: string; filter: "is_best_seller" | "is_popular_now"; resultCount: number; searchedAt: string }> = [];
  const instrumentation: SourceInstrumentation = {
    mode: "live_scrape",
    liveResultCount: 0,
    categoriesSearched: categories.length,
    httpErrors: [],
    fallbackReason: null,
  };

  const results: HotSeller[] = [];
  const seenListingIds = new Set<string>();

  // openBrowser/closeBrowser are no-op stubs (Scrapfly transport is stateless HTTP;
  // see etsyScraper.ts:171). Kept around the parallel block for interface compat.
  await openBrowser();

  // Per-category scrape + vision-select round-trip. Used by both passes in parallel.
  // Returns a normalized result so the merge step can dedup, log, and short-circuit
  // on scraperBroken without the per-call await blocking the other categories.
  type CategoryFetchResult = {
    category: string;
    logEntry: { query: string; url: string; filter: EtsySearchFilter; resultCount: number; searchedAt: string };
    scraperBroken: boolean;
    errorMessage?: string | null;
    pageNotRendered: boolean;
    selectedTiles: EtsyTile[];
  };
  const fetchAndSelectCategory = async (
    category: string,
    filter: EtsySearchFilter
  ): Promise<CategoryFetchResult> => {
    const searchResult = await fetchEtsySearchPage(category, filter);
    const encodedQ = encodeURIComponent(category);
    const filterParam = filter === "is_best_seller" ? "is_best_seller=true" : "is_popular_now=true";
    const logEntry = {
      query: category,
      url: `https://www.etsy.com/search?q=${encodedQ}&explicit=1&${filterParam}`,
      filter,
      resultCount: searchResult.tiles.length,
      searchedAt: new Date().toISOString(),
    };
    if (searchResult.scraperBroken) {
      return { category, logEntry, scraperBroken: true, errorMessage: searchResult.errorMessage, pageNotRendered: false, selectedTiles: [] };
    }
    if (!searchResult.pageRendered) {
      return { category, logEntry, scraperBroken: false, errorMessage: searchResult.errorMessage, pageNotRendered: true, selectedTiles: [] };
    }
    if (searchResult.tiles.length === 0) {
      console.log(`[NicheHunter][CATEGORY] "${category}" → 0 tiles from scraper (${filter})`);
      return { category, logEntry, scraperBroken: false, pageNotRendered: false, selectedTiles: [] };
    }
    // Vision LLM selection (niche-aware: prefers mascot/catchphrase fit, rejects costume gimmicks)
    const { selectedIds, rejectionNotes } = await selectGraphicTeeTiles(category, searchResult.tiles, nicheContext);
    console.log(`[NicheHunter][CATEGORY] "${category}" (${filter}) → scraped=${searchResult.tiles.length} | selected=${selectedIds.length} | notes: ${rejectionNotes.slice(0, 80)}`);
    const selectedTiles = searchResult.tiles.filter(t => selectedIds.includes(t.listingId));
    return { category, logEntry, scraperBroken: false, pageNotRendered: false, selectedTiles };
  };

  // Serial merge: append to searchLog/results in input order so downstream
  // pattern-by-index behavior stays deterministic. Returns added counts per category.
  const mergeResults = (passResults: CategoryFetchResult[]): Record<string, number> => {
    const counts: Record<string, number> = {};
    for (const r of passResults) {
      searchLog.push(r.logEntry);
      if (r.pageNotRendered) {
        console.warn(`[NicheHunter][CATEGORY] "${r.category}" → Page not rendered: ${r.errorMessage}`);
        instrumentation.httpErrors.push({ category: r.category, status: 0, message: r.errorMessage ?? "Page not rendered" });
        counts[r.category] = 0;
        continue;
      }
      let added = 0;
      for (const tile of r.selectedTiles) {
        if (seenListingIds.has(tile.listingId)) continue;
        seenListingIds.add(tile.listingId);
        results.push({
          title: tile.title,
          category: r.category,
          estimatedSales: tile.reviewCount,
          imageDescription: "",
          sourceUrl: tile.listingUrl,
          sourceImageUrl: tile.fullResUrl,
          sourceReviewCount: tile.reviewCount,
          sourceBadge: tile.badge,
        });
        added++;
      }
      counts[r.category] = added;
    }
    return counts;
  };

  try {
    // ── Pass 1: is_best_seller (parallel across categories) ────────────────
    // Previously serial: 5 categories × (scrape ~3-5s + vision LLM ~5-10s) = ~40-75s.
    // Parallel: bounded by the slowest single category = ~10-15s. ScrapFly is stateless
    // HTTP so concurrent calls are safe; OpenAI 5-way concurrency is well within tier
    // limits. Promise.all cannot early-return on scraperBroken — we check after settle.
    const pass1Results = await Promise.all(categories.map(c => fetchAndSelectCategory(c, "is_best_seller")));
    const brokenP1 = pass1Results.find(r => r.scraperBroken);
    if (brokenP1) {
      // SCRAPER_BROKEN: Etsy HTML structure changed — fail the entire scan with a distinct error
      instrumentation.mode = "scraper_broken";
      instrumentation.fallbackReason = brokenP1.errorMessage ?? null;
      console.error(`[NicheHunter] ⛔ SCRAPER_BROKEN for category "${brokenP1.category}": ${brokenP1.errorMessage}`);
      // Push every pass-1 log entry we did make (transparency over partial work) and bail
      for (const r of pass1Results) searchLog.push(r.logEntry);
      return { sellers: [], instrumentation, searchLog };
    }
    const pass1Counts = mergeResults(pass1Results);

    // ── Pass 2: is_popular_now for categories that yielded < 2 tiles ──────
    const pass2Categories = categories.filter(c => (pass1Counts[c] ?? 0) < 2);
    if (pass2Categories.length > 0) {
      console.log(`[NicheHunter] Pass 2 (popular_now) for ${pass2Categories.length} starved categories: ${pass2Categories.join(", ")}`);
      const pass2Results = await Promise.all(pass2Categories.map(c => fetchAndSelectCategory(c, "is_popular_now")));
      const brokenP2 = pass2Results.find(r => r.scraperBroken);
      if (brokenP2) {
        instrumentation.mode = "scraper_broken";
        instrumentation.fallbackReason = brokenP2.errorMessage ?? null;
        console.error(`[NicheHunter] ⛔ SCRAPER_BROKEN (pass 2) for "${brokenP2.category}": ${brokenP2.errorMessage}`);
        for (const r of pass2Results) searchLog.push(r.logEntry);
        return { sellers: [], instrumentation, searchLog };
      }
      mergeResults(pass2Results);
    }
  } finally {
    await closeBrowser();
  }

  instrumentation.liveResultCount = results.length;
  if (results.length === 0) {
    instrumentation.mode = "zero_results";
    instrumentation.fallbackReason = "Scraper returned 0 selected tiles across all categories and both passes";
    console.warn(`[NicheHunter] ⚠️ ZERO RESULTS: Scraper found no graphic tee tiles — scan will save 0 patterns (no fiction)`);
  } else {
    console.log(`[NicheHunter] ✅ LIVE SCRAPE: ${results.length} real Etsy tiles selected across ${categories.length} categories`);
  }

  return { sellers: results, instrumentation, searchLog };
}

// ─── Step 1b: Style extraction per hot seller ─────────────────────────────────

/**
 * Run Vision LLM style extraction on each hot seller that has a source image.
 * Non-blocking per listing — failures return null (prompt_only fallback).
 * Capped at 8 concurrent extractions to avoid API overload.
 *
 * NB: prior implementation was serial despite the "8 concurrent" claim — ~30 sources
 * × ~10s per vision LLM call meant ~5 minutes of forced serialization at scan
 * progress 20→35. Empirically observed: a scan stuck at progress=20 for ~10 minutes
 * straight before this fix. Batch parallelism preserves return-order (callers
 * use the result array by hotSellers index).
 */
async function extractStylesForHotSellers(
  hotSellers: HotSeller[]
): Promise<(SourceStyleJSON | null)[]> {
  const CONCURRENCY = 8;
  const results: (SourceStyleJSON | null)[] = new Array(hotSellers.length).fill(null);
  for (let i = 0; i < hotSellers.length; i += CONCURRENCY) {
    const batch = hotSellers.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(s =>
        s.sourceImageUrl ? extractStyleFromImage(s.sourceImageUrl) : Promise.resolve(null)
      )
    );
    for (let j = 0; j < batchResults.length; j++) {
      results[i + j] = batchResults[j];
    }
  }
  return results;
}

// ─── Step 2: In-niche Reddit signal extraction ────────────────────────────────

interface NicheSignals {
  recurringPhrases: string[];
  insideJokes: string[];
  communityLanguage: string[];
  buyingTriggers: string[];
}

async function extractInNicheSignals(
  subreddits: string[],
  nicheProfile: NicheProfile
): Promise<NicheSignals> {
  const subList = subreddits.slice(0, 4).join(", ");

  // Build cultural map context for richer signal extraction
  const culturalMap = nicheProfile.culturalMap;
  const catchphrases = culturalMap?.catchphrases?.slice(0, 8).join(", ") ?? "";
  const insideJokes = culturalMap?.insideJokes?.slice(0, 5).map(j => j.joke).join(", ") ?? "";
  const painPoints = culturalMap?.painPoints?.slice(0, 4).map(p => p.pain).join(", ") ?? "";
  const legacyMoments = (nicheProfile.culturalMoments ?? []).slice(0, 8).join(", ");
  const culturalContext = [catchphrases, insideJokes, painPoints, legacyMoments]
    .filter(Boolean).join("; ");

  const response = await invokeLLM({
    messages: [
      {
        role: "system",
        content: `You are a community research expert who analyzes niche online communities for t-shirt design signals.
Return ONLY valid JSON with:
- recurringPhrases: string[] (8-12 actual phrases/slogans this community uses)
- insideJokes: string[] (6-10 inside jokes or memes)
- communityLanguage: string[] (6-10 unique vocabulary/slang terms)
- buyingTriggers: string[] (4-6 emotional reasons this community buys apparel)`,
      },
      {
        role: "user",
        content: `Niche: ${nicheProfile.summary ?? ""}
Target audience: ${nicheProfile.targetAudience ?? ""}
Communities: ${subList}
Known cultural context: ${culturalContext}

Extract the most powerful design signals from this community.`,
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "niche_signals",
        strict: true,
        schema: {
          type: "object",
          properties: {
            recurringPhrases: { type: "array", items: { type: "string" } },
            insideJokes: { type: "array", items: { type: "string" } },
            communityLanguage: { type: "array", items: { type: "string" } },
            buyingTriggers: { type: "array", items: { type: "string" } },
          },
          required: ["recurringPhrases", "insideJokes", "communityLanguage", "buyingTriggers"],
          additionalProperties: false,
        },
      },
    },
  });

  const content2 = response.choices?.[0]?.message?.content;
  const raw = typeof content2 === "string" ? content2 : (content2 as TextContent[])?.find(p => p.type === "text")?.text ?? null;
  if (!raw) {
    return { recurringPhrases: [], insideJokes: [], communityLanguage: [], buyingTriggers: [] };
  }
  try {
    return JSON.parse(raw) as NicheSignals;
  } catch {
    return { recurringPhrases: [], insideJokes: [], communityLanguage: [], buyingTriggers: [] };
  }
}

// ─── Steps 3 + 4: Deconstruct hot sellers → adapt for target niche ────────────

interface DeconstructedPattern {
  patternName: string;
  composition: string;
  colorStrategy: string;
  emotionalHook: string;
  transferablePattern: string;
  whyItWorks: string;
  adaptedConcept: string;
  transferValid: boolean;
  transferReasoning: string;
  /** Creative reasoning: what makes this design work in the target niche */
  nicheAdaptationStrategy?: string;
  /** Structured character/animal swaps — used to build minimal edit prompt */
  characterSwaps?: Array<{ from: string; to: string }>;
  /** Structured text/scenery swaps (can combine with characterSwaps) */
  contextSwaps?: Array<{ from: string; to: string }>;
}

async function deconstructAndAdapt(
  hotSellers: HotSeller[],
  nicheSignals: NicheSignals,
  nicheProfile: NicheProfile,
  sourceStyles: (SourceStyleJSON | null)[]
): Promise<DeconstructedPattern[]> {
  const sellersText = hotSellers
    .map((s, i) => {
      // Use vision-extracted subject as ground truth; fall back to category only if unavailable
      const visualSubject = sourceStyles[i]?.subject ?? s.category;
      return `${i + 1}. "${s.title}" (~${s.estimatedSales} reviews)\n   Visual subject (vision-extracted): ${visualSubject}`;
    })
    .join("\n");

  const signalsText = [
    `Recurring phrases: ${nicheSignals.recurringPhrases.slice(0, 6).join(", ")}`,
    `Inside jokes: ${nicheSignals.insideJokes.slice(0, 5).join(", ")}`,
    `Buying triggers: ${nicheSignals.buyingTriggers.join(", ")}`,
  ].join("\n");

  // Build cultural map context for richer adaptation
  const culturalMap = nicheProfile.culturalMap;
  let culturalContext = "";
  if (culturalMap) {
    const parts: string[] = [];
    if (culturalMap.animalMascots?.length) {
      parts.push(`Animal mascots that work: ${culturalMap.animalMascots.slice(0, 3).map(a => `${a.animal} (${a.whyItWorks})`).join("; ")}`);
    }
    if (culturalMap.painPoints?.length) {
      parts.push(`Pain points with humor: ${culturalMap.painPoints.slice(0, 3).map(p => `${p.pain} → ${p.humorAngle}`).join("; ")}`);
    }
    if (culturalMap.physicalComedy?.length) {
      parts.push(`Physical comedy scenarios: ${culturalMap.physicalComedy.slice(0, 3).map(c => c.scenario).join("; ")}`);
    }
    if (culturalMap.rivalries?.length) {
      parts.push(`Rivalries: ${culturalMap.rivalries.slice(0, 2).map(r => `${r.rivalry} — ${r.humorAngle}`).join("; ")}`);
    }
    if (culturalMap.catchphrases?.length) {
      parts.push(`Catchphrases: ${culturalMap.catchphrases.slice(0, 6).join(", ")}`);
    }
    if (culturalMap.funPoints?.length) {
      parts.push(`Fun points (joys): ${culturalMap.funPoints.slice(0, 3).map(f => `${f.joy} → ${f.visualConcept}`).join("; ")}`);
    }
    if (culturalMap.insideJokes?.length) {
      parts.push(`Inside jokes: ${culturalMap.insideJokes.slice(0, 3).map(j => `${j.joke} (${j.context})`).join("; ")}`);
    }
    if (culturalMap.lifestyleIdentity?.length) {
      parts.push(`Lifestyle identity: ${culturalMap.lifestyleIdentity.slice(0, 3).map(l => `${l.trait} → ${l.purchaseDriver}`).join("; ")}`);
    }
    culturalContext = parts.join("\n");
  }

  const response = await invokeLLM({
    messages: [
      {
        role: "system",
        content: `You are a print-on-demand design strategist. Your job is to:
1. Deconstruct why each hot-selling listing works (composition, color, emotional hook)
2. Extract the transferable design PATTERN (not the specific content)
3. THINK: "What can I do with this design to make it niche-specific?" — identify the core joke/hook and find the TARGET NICHE equivalent
4. Write your creative reasoning in nicheAdaptationStrategy BEFORE filling in swap pairs
5. Derive characterSwaps and contextSwaps FROM your nicheAdaptationStrategy reasoning

=== HARD CONSTRAINT: TRANSFER VALIDATION ===
After adapting each concept, you MUST evaluate whether the core pun, wordplay, or emotional hook
actually works in the TARGET niche — not just the source niche.

Ask: "Does this joke/pun/hook make sense WITHOUT knowing the source niche?"
- YES → transferValid: true, explain briefly in transferReasoning
- NO but CAN be re-anchored → rewrite adaptedConcept with the re-anchored version using target niche vocabulary, set transferValid: true, explain in transferReasoning
- NO and CANNOT be re-anchored meaningfully → transferValid: false, explain in transferReasoning

Example:
  Source: "Reel Cool Dinker" (fishing pun — "reel" = fishing reel)
  Naive adaptation: "Reel Cool Dinker" with a fishing rod on a pickleball shirt → INVALID (pun only works in fishing)
  Re-anchored: "Real Cool Dinker — Because Dinking IS an Art" → VALID (re-anchored to pickleball vocabulary)
===========================================

=== CRITICAL: adaptedConcept FORMAT ===
The "adaptedConcept" field is fed DIRECTLY to an image generator that will edit the source image.
It must describe a 1:1 SUBJECT SWAP that preserves the source layout.

GOOD adaptedConcept: "5 cats in pickleball poses (serving, dinking, volleying, celebrating, stretching) with title 'Pickleball Master' at top and subtitle 'Still working on my third shot drop' at bottom"
BAD adaptedConcept: "I'd Rather Be Dinking — funny pickleball quote shirt" (this is a totally new concept, not a subject swap)

The adaptedConcept must reference the SAME number of elements, SAME layout structure, and ONLY change what activity/subject is depicted.
===========================================

=== HARD CONSTRAINT: TARGET NICHE ENFORCEMENT (Fix #2 + AR2) ===
The ONLY target niche is: ${nicheProfile.summary?.split(',')[0] || nicheProfile.summary || 'the target niche'}.
Every single adaptedConcept MUST be about THIS target niche and nothing else.
NEVER adapt to another sport or hobby. If the source is bowling,
the adaptation is the TARGET NICHE — not soccer, not tennis, not anything else.
The target niche identity comes from the workspace profile — use its vocabulary exclusively.
===========================================

=== HARD CONSTRAINT: CHARACTER-ONLY SWAP (Fix #5 + AR1 + AR3) ===
The ONLY thing that changes is the CHARACTER/ANIMAL names. Everything else stays IDENTICAL.

=== TYPE-MATCHING RULE (CRITICAL) ===
Character replacements MUST match the TYPE of the source:
- Source has ANIMALS/CREATURES → replace with niche ANIMAL mascots (T-Rex, Llama, Capybara, etc.)
- Source has HUMAN CHARACTERS (people, cartoon people, named characters) → replace with HUMAN pickleball players/enthusiasts
- NEVER replace human characters with animals. NEVER replace animals with humans.

✅ CORRECT (animal→animal): Source = Bigfoot booping a cat under a moon
   → Adaptation = T-Rex booping a Llama under a moon
   (animals replaced with niche animal mascots)

✅ CORRECT (human→human): Source = Star Trek characters in Dr. Seuss counting layout
   → Adaptation = Pickleball players in the same counting layout (server, dinker, lobber, ref)
   (human characters replaced with niche-relevant human roles)

✅ CORRECT (human→human): Source = cartoon people in uniforms
   → Adaptation = cartoon pickleball players in team jerseys

❌ WRONG: Source = Star Trek characters (humans)
   → Adaptation = T-Rexes (replaced humans with animals — FORBIDDEN type mismatch)

❌ WRONG: Source = Bigfoot booping a cat
   → Adaptation = Bigfoot booping a Llama (kept Bigfoot — FORBIDDEN, Bigfoot is not a niche mascot)

❌ WRONG: Source = frog riding a bicycle with a wizard hat
   → Adaptation = T-Rex riding a pickleball cart with a sword
   (changed the vehicle, changed the accessory — FORBIDDEN)

❌ INJECTION (forbidden): If the source does NOT have an element, you must NOT add it.
   Example: Source has NO animal → do NOT add Cats, Llama, T-Rex, or any animal
   Example: Source has NO text → do NOT add a slogan

RULE: Replace EVERY character/animal in the source with a niche equivalent from the cultural map.
For animals: use animal mascots. For humans: use niche-specific human roles (player, coach, ref, spectator).
The character names are the ONLY variables. Pose, accessories, layout, style, text — all copied verbatim.

Element count must match: source has 4 characters → adaptation has exactly 4 characters.
===========================================

=== HARD CONSTRAINT: NO TEXT INJECTION (Fix #9) ===
- If the source design has NO text/words/slogans, the adaptedConcept must describe a design with NO text.
- DO NOT invent slogans unless the source already had a slogan.
- If the source HAS text, replace it with target-niche-equivalent text of the SAME length and position.
===========================================

=== HARD CONSTRAINT: NICHE-SPECIFIC VOCABULARY (Fix #8 + AR2) ===
When text IS present in the source and needs adaptation, use ONLY vocabulary specific to the target niche.
${culturalMap?.catchphrases?.length ? `Approved niche vocabulary: ${culturalMap.catchphrases.slice(0, 12).join(", ")}` : "Use insider terminology from the community signals above."}
- BAD: generic phrases like "find your zen", "game day", "love the game" — these apply to ANY hobby/sport
Every adapted phrase must be UNMISTAKABLY about the target niche to someone who has never seen the source.
===========================================

Return ONLY valid JSON: an array of objects, one per hot seller analyzed.`,
      },
      {
        role: "user",
        content: `TARGET NICHE: ${nicheProfile.summary ?? ""}
Audience: ${nicheProfile.targetAudience ?? ""}

COMMUNITY SIGNALS:
${signalsText}

CULTURAL MAP (use for REPLACEMENT swaps of existing source elements — NEVER for injection):
${culturalContext || "Not available — use community signals only"}

HOT SELLERS TO DECONSTRUCT:
${sellersText}

Deconstruct each hot seller and adapt it for the target niche. Use the cultural map to find the RIGHT replacement when the source already has a swappable element (animal→animal, character→character). Do NOT add elements from the map that have no counterpart in the source.`,
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "deconstructed_patterns",
        strict: true,
        schema: {
          type: "array",
          items: {
            type: "object",
            properties: {
              patternName: { type: "string" },
              composition: { type: "string" },
              colorStrategy: { type: "string" },
              emotionalHook: { type: "string" },
              transferablePattern: { type: "string" },
              whyItWorks: { type: "string" },
              adaptedConcept: { type: "string" },
              transferValid: { type: "boolean" },
              transferReasoning: { type: "string" },
              nicheAdaptationStrategy: {
                type: "string",
                description: "THINK FIRST: Before writing any swaps, reason about: (1) What is the core joke/hook/emotional trigger of this source design? (2) What is the EQUIVALENT joke/hook in the target niche that would make fans laugh/buy? (3) What specific niche vocabulary, inside jokes, or cultural references map to the source elements? Write 2-3 sentences explaining your creative reasoning for HOW this design becomes niche-specific. This reasoning drives the swap pairs below.",
              },
              characterSwaps: {
                type: "array",
                description: "List of character/animal swaps derived from your nicheAdaptationStrategy above. Each entry is a from→to pair. ONLY include elements that exist in the source image. Empty array if source has no characters/animals. TYPE-MATCH: humans→humans (pickleball players), animals→animals (niche mascots). Never cross types.",
                items: {
                  type: "object",
                  properties: {
                    from: { type: "string", description: "Exact character/animal in the source (e.g. 'Star Trek captain', 'Bigfoot', 'cat')" },
                    to: { type: "string", description: "Niche replacement matching source type. If source is human: use human role (e.g. 'pickleball server', 'dinker', 'ref'). If source is animal: use niche mascot (e.g. 'T-Rex', 'Llama')." },
                  },
                  required: ["from", "to"],
                  additionalProperties: false,
                },
              },
              contextSwaps: {
                type: "array",
                description: "List of text/scenery/background swaps derived from your nicheAdaptationStrategy. Use for text replacements AND scenery changes. Can be used ALONGSIDE characterSwaps when the source has both characters AND text. Empty array only if source has nothing to swap beyond characters.",
                items: {
                  type: "object",
                  properties: {
                    from: { type: "string", description: "Exact text or scenery element in source (e.g. 'YOU ARE NOT ALMOST THERE', 'mountains')" },
                    to: { type: "string", description: "Niche-equivalent replacement (e.g. 'JUST ONE MORE GAME', 'pickleball court')" },
                  },
                  required: ["from", "to"],
                  additionalProperties: false,
                },
              },
            },
            required: [
              "patternName", "composition", "colorStrategy", "emotionalHook",
              "transferablePattern", "whyItWorks", "adaptedConcept",
              "transferValid", "transferReasoning", "nicheAdaptationStrategy", "characterSwaps", "contextSwaps",
            ],
            additionalProperties: false,
          },
        },
      },
    },
    model: "gemini-2.5-pro",
  });

  const content3 = response.choices?.[0]?.message?.content;
  const raw = typeof content3 === "string" ? content3 : (content3 as TextContent[])?.find(p => p.type === "text")?.text ?? null;
  if (!raw) return [];
  try {
    return JSON.parse(raw) as DeconstructedPattern[];
  } catch {
    return [];
  }
}

// ─── Three-Mode Generation ────────────────────────────────────────────────────

/**
 * Determine the adaptation mode for a pattern based on available source data.
 * edit_source    — source image URL available AND style extraction succeeded
 * style_reference — source image URL available but style extraction failed
 * prompt_only    — no source image URL
 */
export function determineAdaptationMode(
  sourceImageUrl: string | undefined,
  sourceStyle: SourceStyleJSON | null
): AdaptationMode {
  if (!sourceImageUrl) return "prompt_only";
  if (sourceStyle) return "edit_source";
  return "style_reference";
}

/**
 * Call OpenAI gpt-image-2 /images/edits endpoint directly.
 * Returns a durable S3 URL of the generated image.
 * Fail-loud: throws on any error (NO fallback to Forge).
 */
async function callGptImage2Edit(prompt: string, sourceImageUrl: string): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not configured — cannot call gpt-image-2");

  console.log(`[NicheHunter] Calling gpt-image-2 edit. Prompt: "${prompt.substring(0, 100)}..."`);

  // Download source image to send as multipart (proven format from spike)
  const imgResp = await fetch(sourceImageUrl);
  if (!imgResp.ok) throw new Error(`Failed to download source image: ${imgResp.status}`);
  const imgBuf = Buffer.from(await imgResp.arrayBuffer());

  const formData = new FormData();
  formData.append("model", "gpt-image-2");
  formData.append("prompt", prompt);
  formData.append("size", "2048x2048");
  const blob = new Blob([imgBuf], { type: "image/jpeg" });
  formData.append("image[]", blob, "source.jpg");

  const resp = await fetch("https://api.openai.com/v1/images/edits", {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}` },
    body: formData,
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`gpt-image-2 API error (${resp.status}): ${errText.substring(0, 300)}`);
  }

  const data = await resp.json() as { data: Array<{ b64_json?: string; url?: string }> };
  const item = data.data?.[0];
  if (!item) throw new Error("gpt-image-2 returned no image data");

  let buffer: Buffer;
  if (item.b64_json) {
    buffer = Buffer.from(item.b64_json, "base64");
  } else if (item.url) {
    const dlResp = await fetch(item.url);
    buffer = Buffer.from(await dlResp.arrayBuffer());
  } else {
    throw new Error("gpt-image-2 response has neither b64_json nor url");
  }

  // Upload to S3 for durable URL
  const { url } = await storagePut(`generated/gpt-image-2/${Date.now()}.png`, buffer, "image/png");
  console.log(`[NicheHunter] gpt-image-2 result uploaded to S3: ${url}`);
  return url;
}

/**
 * Build an image generation prompt and optional originalImages for a pattern.
 * In edit_source mode: minimal one-sentence template for gpt-image-2 (PO-approved Spike A/C).
 * In style_reference/prompt_only modes: descriptive prompt for Forge.
 *
 * In edit_source mode, the CHARACTER SWAP RULE applies:
 *   - If the source has a character/creature present in transferableVisualConcepts,
 *     replace that character with the mapped target (e.g. Bigfoot → Llama).
 *   - Keep ALL other visual elements (dandelion, composition, style, palette) unchanged.
 *   - NEVER swap the activity — the activity is part of the visual concept being transferred.
 */
function buildGenerationPayload(
  pattern: DeconstructedPattern,
  mode: AdaptationMode,
  sourceImageUrl: string | undefined,
  sourceStyle: SourceStyleJSON | null,
  nicheProfile?: NicheProfile
): { prompt: string; originalImages?: Array<{ url: string; mimeType: string }> } {
  const baseSubject = pattern.adaptedConcept;
  const composition = pattern.composition;

  if (mode === "edit_source" && sourceImageUrl && sourceStyle) {
    // gpt-image-2 minimal one-sentence template (PO-approved Spike A/C pattern).
    // The matching algorithm finds the TARGET_CHARACTER from culturalMap.
    const transferMappings = nicheProfile?.culturalMap?.transferableVisualConcepts ?? [];
    const sourceSubject = sourceStyle.subject ?? "";

    // Token-overlap matching: tokenize → drop stopwords → require ≥2 overlap → prefer highest.
    const SWAP_STOPWORDS = new Set([
      "a", "an", "the", "and", "or", "of", "in", "on", "at", "to", "for",
      "with", "by", "from", "is", "it", "its", "as", "are", "was", "be",
      "this", "that", "have", "has", "had", "do", "does", "did", "not",
    ]);
    const tokenizeSubject = (text: string): Set<string> => new Set(
      text.toLowerCase()
        .split(/[\s/,\-\u2013\u2014.!?()]+/)
        .filter(w => w.length > 2 && !SWAP_STOPWORDS.has(w))
    );

    let targetCharacter = "";
    if (transferMappings.length > 0 && sourceSubject) {
      const sourceTokens = tokenizeSubject(sourceSubject);
      let bestMatch: typeof transferMappings[0] | null = null;
      let bestOverlap = 0;

      for (const m of transferMappings) {
        const patternTokens = tokenizeSubject(m.sourcePattern ?? "");
        let overlap = 0;
        Array.from(patternTokens).forEach(t => {
          if (sourceTokens.has(t)) overlap++;
        });
        if (overlap >= 2 && overlap > bestOverlap) {
          bestOverlap = overlap;
          bestMatch = m;
        }
      }

      if (bestMatch) {
        targetCharacter = bestMatch.targetAdaptation;
        console.log(`[NicheHunter] Character swap found (overlap=${bestOverlap}): "${sourceSubject}" \u2192 "${targetCharacter}" (via transferableVisualConcepts)`);
      } else {
        console.log(`[NicheHunter] No character swap match for subject: "${sourceSubject}" (${sourceTokens.size} tokens, best overlap=${bestOverlap})`);
      }
    }

    // Fall back: try animalMascots if source has a character element but no transferableVisualConcepts match
    if (!targetCharacter && nicheProfile?.culturalMap?.animalMascots?.length) {
      // Only use mascot fallback if the source subject looks like a character/creature
      const characterIndicators = /\b(animal|cat|dog|bear|wolf|fox|owl|bird|gorilla|bigfoot|sloth|dinosaur|dragon|creature|monster|character|person|figure|mascot)\b/i;
      if (characterIndicators.test(sourceSubject)) {
        const randomMascot = nicheProfile.culturalMap.animalMascots[
          Math.floor(Math.random() * nicheProfile.culturalMap.animalMascots.length)
        ];
        targetCharacter = `${randomMascot.animal} (${randomMascot.visualTreatment})`;
        console.log(`[NicheHunter] Mascot fallback: "${sourceSubject}" → "${targetCharacter}"`);
      }
    }
    // Final fall back to adaptedConcept if no cultural-map match and no mascot fallback
    if (!targetCharacter) {
      targetCharacter = baseSubject;
    }

    // Derive the one-phrase shirt description from styleJSON
    const shirtDesc = sourceStyle.garmentStyle || "comfort color tee";

    // Build the one-sentence prompt (Spike A pattern).
    // Output design on white background (not on shirt) so flood-fill can extract it for compositing.
    let prompt = `Instead of a ${sourceSubject || "the original character"}, change it to a ${targetCharacter}. Output the design artwork only on a plain white background, not on a shirt.`;

    // Append composition phrase when available (Spike C refinement)
    if (sourceStyle.composition && sourceStyle.composition !== "NONE") {
      prompt += ` ${sourceStyle.subjectCrop || "centered bust portrait"} composition matching the reference.`;
    }

    return {
      prompt,
      originalImages: [{ url: sourceImageUrl, mimeType: "image/jpeg" }],
    };
  }

  if (mode === "style_reference" && sourceImageUrl) {
    // Medium fidelity: use source image as style reference, describe style from pattern fields
    const prompt = `Create a t-shirt graphic design inspired by the visual style of the reference image. ` +
      `New subject: ${baseSubject}. ` +
      `Composition: ${composition}. ` +
      `Color approach: ${pattern.colorStrategy}. ` +
      `Mood: ${pattern.emotionalHook}. ` +
      `Match the overall artistic style, technique, and era of the reference. ` +
      `Transparent background, print-ready DTF art, no shirt visible.`;

    return {
      prompt,
      originalImages: [{ url: sourceImageUrl, mimeType: "image/jpeg" }],
    };
  }

  // prompt_only: pure text prompt
  const prompt = `T-shirt graphic design: ${baseSubject}. ` +
    `Composition: ${composition}. ` +
    `Color palette: ${pattern.colorStrategy}. ` +
    `Style: print-on-demand apparel art. ` +
    `Transparent background, centered design, no shirt visible.`;

  return { prompt };
}

// ─── Step 5: Rank patterns ──────────────────────────────────────────────────

async function rankPatterns(
  workspaceId: string,
  profile: NicheProfile
): Promise<void> {
  const patterns = await getTrendPatternsByWorkspace(workspaceId, "discovered");
  if (patterns.length === 0) return;

  const patternSummaries = patterns.map((p, i) => ({
    index: i,
    id: p.id,
    patternName: p.patternName,
    adaptedConcept: p.adaptedConcept,
    composition: p.composition,
    emotionalHook: p.emotionalHook,
  }));

  // Build cultural map context for ranking
  const culturalMap = profile.culturalMap;
  const catchphrases = culturalMap?.catchphrases?.slice(0, 6).join(", ") ?? "";
  const insideJokes = culturalMap?.insideJokes?.slice(0, 4).map(j => j.joke).join(", ") ?? "";
  const legacyCulturalMoments = (profile.culturalMoments ?? []).slice(0, 6).join(", ");
  const culturalContext = [catchphrases, insideJokes, legacyCulturalMoments].filter(Boolean).join("; ");

  const response = await invokeLLM({
    messages: [
      {
        role: "system",
        content: `You are a print-on-demand market analyst. You rank design concepts by their commercial potential for a specific niche.

Niche: ${profile.summary ?? "General apparel"}
Target audience: ${profile.targetAudience ?? "Adults"}
Design styles they love: ${(profile.designStyles ?? []).join(", ")}
Cultural context / inside jokes: ${culturalContext || "Not available"}

Score each concept from 0-100 based on:
- Market fit (does this match what the audience actually buys?) — 40%
- Originality (is this fresh or overdone?) — 30%
- Emotional resonance (will this make someone say "I NEED that"?) — 30%

Return a JSON array with one object per concept:
[{ "index": 0, "score": 85, "reasoning": "One sentence explaining why this scored high/low" }]

Be harsh. Most concepts should score 40-70. Only truly exceptional ones get 80+.`,
      },
      {
        role: "user",
        content: `Rank these ${patternSummaries.length} concepts:\n${JSON.stringify(patternSummaries, null, 2)}`,
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "pattern_rankings",
        strict: true,
        schema: {
          type: "array",
          items: {
            type: "object",
            properties: {
              index: { type: "integer" },
              score: { type: "integer" },
              reasoning: { type: "string" },
            },
            required: ["index", "score", "reasoning"],
            additionalProperties: false,
          },
        },
      },
    },
  });

  const content = response.choices?.[0]?.message?.content;
  const raw = typeof content === "string" ? content : (content as TextContent[])?.find(p => p.type === "text")?.text ?? null;
  if (!raw) return;

  try {
    const rankings = JSON.parse(raw) as { index: number; score: number; reasoning: string }[];
    for (const r of rankings) {
      const pattern = patternSummaries[r.index];
      if (pattern) {
        await updateTrendPatternScore(pattern.id, r.score, r.reasoning);
      }
    }
  } catch {
    console.warn("[NicheHunter] Failed to parse ranking response");
  }
}

// ─── General Best Seller Term Resolution ─────────────────────────────────────

/**
 * Resolve general best-seller search terms for Etsy scraping.
 * These represent what's hot in the GENERAL market for the product type being sold
 * (e.g., "funny shirt", "graphic shirt", "graphic tee").
 *
 * Priority order:
 *   1. Explicit generalBestSellerTerms in nicheProfile (user-configured in workspace settings)
 *   2. SKIP auto-derivation if the user has explicit crossNicheCategories — their
 *      category budget is finite (5 slots) and auto-injected terms ("funny shirt",
 *      "graphic tee") would crowd out the categories the user actually chose.
 *   3. Auto-derived from workspace product groups (productType field → search terms)
 *   4. Default fallback for graphic tee businesses (only when user gave no signal at all)
 */
async function resolveGeneralBestSellerTerms(
  profile: NicheProfile,
  workspaceId: string
): Promise<string[]> {
  // Priority 1: Explicit user-configured terms always win
  if (profile.generalBestSellerTerms && profile.generalBestSellerTerms.length > 0) {
    return profile.generalBestSellerTerms;
  }

  // Priority 2: User has explicit cross-niche categories → respect their scrape
  // budget. Auto-injecting "funny shirt"/"graphic tee" here was crowding out
  // user-chosen categories (each general term eats 1 of 5 budget slots), and
  // "funny shirt" Etsy results skew toward costume gimmicks (e.g. 3D-printed
  // fake-hairy-chest tees) that have no transferable design language.
  if ((profile.crossNicheCategories ?? []).length > 0) {
    return [];
  }

  // Priority 3: Derive from product groups
  try {
    const groups = await getProductGroupsByWorkspace(workspaceId);
    if (groups.length > 0) {
      const productTypes = Array.from(new Set(
        groups.map(g => (g.productType ?? "T-Shirt").toLowerCase())
      ));
      return deriveSearchTermsFromProductTypes(productTypes);
    }
  } catch (err) {
    console.warn(`[NicheHunter] Failed to fetch product groups for general terms: ${err}`);
  }

  // Priority 4: Default for graphic tee businesses (no user signal at all)
  return ["funny shirt", "graphic tee"];
}

/**
 * Convert product type labels into Etsy search terms for general best-seller discovery.
 * Maps common product types to the search queries buyers actually use on Etsy.
 */
function deriveSearchTermsFromProductTypes(productTypes: string[]): string[] {
  const termMap: Record<string, string[]> = {
    "t-shirt":    ["funny shirt", "graphic tee"],
    "tee":        ["funny shirt", "graphic tee"],
    "shirt":      ["funny shirt", "graphic shirt"],
    "hoodie":     ["funny hoodie", "graphic hoodie"],
    "sweatshirt": ["funny sweatshirt", "graphic sweatshirt"],
    "tank":       ["funny tank top", "graphic tank"],
    "tank top":   ["funny tank top", "graphic tank"],
    "crewneck":   ["funny crewneck", "graphic crewneck"],
    "long sleeve": ["funny long sleeve shirt", "graphic long sleeve"],
    "mug":        ["funny mug", "graphic mug"],
    "sticker":    ["funny sticker", "graphic sticker"],
    "tote bag":   ["funny tote bag", "graphic tote"],
    "poster":     ["funny poster", "graphic poster"],
  };

  const terms = new Set<string>();
  for (const pt of productTypes) {
    const normalized = pt.toLowerCase().trim();
    const mapped = termMap[normalized];
    if (mapped) {
      mapped.forEach(t => terms.add(t));
    } else {
      // Fallback: construct generic search terms from the product type
      terms.add(`funny ${normalized}`);
      terms.add(`graphic ${normalized}`);
    }
  }

  // Return at most 2 terms — keeps Etsy scrape budget tight
  return Array.from(terms).slice(0, 2);
}

// ─── Main scan orchestrator ───────────────────────────────────────────────────

// Caps: up to MAX_SCAN_CATEGORIES (8) categories × MAX_PATTERNS_PER_CATEGORY designs,
// bounded by MAX_PATTERNS_PER_SCAN total per scan.
// Per-category raised 4→10 (PO 2026-06-08): a single rich vein (e.g. "funny graphic
// shirt") can hold 10+ convertible designs, so don't cut it off at 4. Per-scan stays
// 20 so a few rich categories can fill the budget. Trade-off: more image-gen per run.
const MAX_PATTERNS_PER_SCAN = 20;
const MAX_PATTERNS_PER_CATEGORY = 10;

// ─── Theme-level dedup (vs Concept Library) ──────────────────────────────────
// PO directive: the Concept Library = winning designs we've already explored.
// The scan should skip Etsy sources whose theme overlaps an existing pattern.
// Exact-string match on sourceTitle/patternName misses near-duplicates like
// "Funny Salty Girl Shirt | Women Graphic Tee ..." vs "Salty Girl Tee: Women's
// Vintage Cotton Blend T-Shirt" — both are the same Salty theme, different shops.
// Tier A: extract non-stopword tokens; if ≥2 specific words overlap an existing
// pattern's tokens, skip. Catches Salty/Salty without needing LLM semantic match.
const TITLE_STOPWORDS = new Set([
  "shirt","tee","tshirt","hoodie","sweatshirt","sweater","top","apparel",
  "women","womens","woman","men","mens","man","unisex","ladies","adult","adults",
  "kid","kids","toddler","toddlers","baby","child","children","youth",
  "graphic","funny","vintage","retro","custom","cute","cool","classic","modern",
  "cotton","polyester","poly","heather","blend","soft","comfort","comfy","comfortable",
  "navy","black","white","grey","gray","cream","ivory","tan","red","blue","green",
  "style","styles","design","designs","print","printed","quality","best","top","premium",
  "gift","gifts","for","her","his","him","to","with","and","the","a","an","of","is","in","on","or","by","at",
  "neck","vneck","crew","crewneck","sleeve","sleeves","short","long","fit","fitted","relaxed","oversized","boxy",
  "size","sizes","xl","xxl","xxxl","xs","sm","md","lg","small","medium","large","plus",
  "made","printed","seller","etsy","listing","item","product","shop","store",
  "more","less","new","old","day","days","year","years","time","times",
]);

// Niche-generic words in nearly EVERY pickleball concept name (dink/dinker family +
// pickleball). Stripped from the CONCEPT fingerprint so dedup keys on the DISTINCTIVE word
// (Salty/Happy/Mountain/Master/Squad), not the shared niche root. Without this,
// "Pickleball Dink Master" vs "Pickleball Dink Squad" share {pickleball,dink}=2 and falsely
// dedup (adversarial-review catch 2026-06-10). Exact-name dedup (below) still catches true
// repeats. Pickleball-only module today; harmless no-op for other niches (tokens won't appear).
const NICHE_GENERIC_STOPWORDS = new Set([
  "pickleball","pickleballs","pickle","dink","dinks","dinker","dinkers","dinking",
]);

function extractFingerprint(text: string): Set<string> {
  return new Set(
    (text || "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3 && !TITLE_STOPWORDS.has(w) && !NICHE_GENERIC_STOPWORDS.has(w))
  );
}

/**
 * True if `candidate` and `existing` share at least `minOverlap` distinct
 * non-stopword tokens. Default min=2: "Funny Salty Girl Shirt..." ∩ "Salty Girl
 * Tee..." → {salty, girl} → match. Conservative enough to not over-dedup
 * unrelated patterns that happen to share 1 generic word.
 */
function sharesTheme(candidate: Set<string>, existing: Set<string>, minOverlap = 2): boolean {
  if (candidate.size === 0 || existing.size === 0) return false;
  const words = Array.from(candidate);
  let count = 0;
  for (const w of words) {
    if (existing.has(w)) {
      count++;
      if (count >= minOverlap) return true;
    }
  }
  return false;
}

export async function runNicheHunterScan(
  workspace: Workspace,
  scanId: string,
  etsyApiKey?: string,
  conceptMode: "auto" | "curated" = "auto"
): Promise<void> {
  const profile = (workspace.nicheProfile ?? {}) as NicheProfile;
  const crossNicheCategories = profile.crossNicheCategories ?? [];
  const etsyKeywords = profile.etsyKeywords ?? [];
  const subreddits = profile.subreddits ?? [];

  // Derive general best-seller search terms:
  // Priority 1: Explicit generalBestSellerTerms in nicheProfile (user-configured)
  // Priority 2: Auto-derive from workspace product groups (productType field)
  // Priority 3: Default fallback for graphic tee businesses
  const generalTerms = await resolveGeneralBestSellerTerms(profile, workspace.id);
  console.log(`[NicheHunter] General best-seller terms: [${generalTerms.join(", ")}]`);

  // Build a compact niche context for the vision tile selector. Lets the selector
  // PREFER niche-fit tiles over equally-valid graphic tees that are off-brand
  // (e.g. on a "funny shirt" page, pick the raccoon tee over the costume-gimmick
  // tee) and REJECT failure modes that pass the generic graphic-tee classifier
  // (3D body-illusion costume tees, historical-figure designs).
  const nicheContext: NicheContext = {
    niche: profile.summary || profile.targetAudience || "the niche",
    mascots: (profile.culturalMap?.animalMascots ?? []).map(m => m.animal).filter(Boolean),
    catchphrases: profile.culturalMap?.catchphrases ?? [],
  };

  try {
    // Step 1: Real Etsy hot sellers (scrape-based, no fallback, no fiction)
    await updateScanRun(scanId, { progress: 10 });
    const { sellers: hotSellers, instrumentation, searchLog } = await fetchCrossNicheHotSellers(crossNicheCategories, etsyApiKey, etsyKeywords, generalTerms, nicheContext);
    // Log instrumentation to scan for transparency
    const instrLog = `[Source: ${instrumentation.mode}] Live results: ${instrumentation.liveResultCount}/${instrumentation.categoriesSearched} categories${instrumentation.fallbackReason ? ` | Fallback: ${instrumentation.fallbackReason}` : ""}${instrumentation.httpErrors.length ? ` | HTTP errors: ${instrumentation.httpErrors.map(e => `${e.category}:${e.status}`).join(", ")}` : ""}`;
    console.log(`[NicheHunter] ${instrLog}`);
    // Surface scraper errors in the errorLog so the UI shows "Scan failed" instead of empty state
    const isErrorMode = instrumentation.mode === "scraper_broken" || instrumentation.mode === "zero_results";
    await updateScanRun(scanId, { progress: 20, errorLog: isErrorMode ? instrLog : undefined, searchLog });

    // Step 1b: Style extraction from source images (Vision LLM, non-blocking per listing)
    console.log(`[NicheHunter] Extracting styles from ${hotSellers.filter(s => s.sourceImageUrl).length} source images...`);
    const sourceStyles = await extractStylesForHotSellers(hotSellers);
    await updateScanRun(scanId, { progress: 35 });

    // Step 2: In-niche Reddit signals
    const nicheSignals = await extractInNicheSignals(subreddits, profile);
    await updateScanRun(scanId, { progress: 50 });

    // Steps 3+4: Deconstruct + adapt (cultural map aware)
    const patterns = await deconstructAndAdapt(hotSellers, nicheSignals, profile, sourceStyles);
    await updateScanRun(scanId, { progress: 70 });

    // Cross-scan deduplication — exact-string + theme-fingerprint match.
    const existingPatterns = await getTrendPatternsByWorkspace(workspace.id);
    const existingSourceTitles = new Set(
      existingPatterns.map(ep => (ep.sourceTitle ?? "").toLowerCase().trim()).filter(Boolean)
    );
    const existingPatternNames = new Set(
      existingPatterns.map(ep => (ep.patternName ?? "").toLowerCase().trim()).filter(Boolean)
    );
    // Theme-fingerprints from APPROVED patterns only — Concept Library winners worth
    // protecting from theme-collision in future scans (Salty case). DISMISSED patterns
    // are NOT used here: their signal already feeds the brain via the AVOID list at
    // planning time; if we ALSO pre-block at search time, accumulated dismissed-pattern
    // noise (e.g. 14 dismissed "funny shirt" patterns from pre-fix auto-inject days)
    // crowds out new candidates and yield collapses to ~1 pattern per scan even when
    // scrapes return 60 tiles. PO observed exactly this on the iSa0ctgg scan
    // 2026-06-06: 5 categories scraped clean, only 1 pattern survived (Sunrise Forest).
    // Exact-string dedup above still uses ALL patterns so we don't re-scrape the
    // SAME Etsy listing twice — that's a different concern from theme dedup.
    const approvedPatterns = existingPatterns.filter(ep => ep.status === "approved");
    const existingFingerprints: Set<string>[] = approvedPatterns
      .map(ep => extractFingerprint(ep.patternName ?? ""))
      .filter(fp => fp.size > 0);
    console.log(`[NicheHunter] Dedup baseline: ${existingPatterns.length} total / ${approvedPatterns.length} approved → ${existingFingerprints.length} theme fingerprints`);

    let saved = 0;
    // Per-category counter for the 4-designs-per-category cap (PO spec).
    const savedPerCategory: Record<string, number> = {};
    const totalPatterns = Math.min(patterns.length, hotSellers.length);

    for (let i = 0; i < totalPatterns; i++) {
      // Hard cap: max 20 patterns per scan (5 categories × 4 designs)
      if (saved >= MAX_PATTERNS_PER_SCAN) {
        console.log(`[NicheHunter] Reached ${MAX_PATTERNS_PER_SCAN}-pattern cap — stopping`);
        break;
      }

      const p = patterns[i];
      const hotSeller = hotSellers[i];
      const sourceStyle = sourceStyles[i] ?? null;

      // Per-category cap: skip if this category already has MAX_PATTERNS_PER_CATEGORY saves
      const category = hotSeller?.category ?? "(uncategorized)";
      if ((savedPerCategory[category] ?? 0) >= MAX_PATTERNS_PER_CATEGORY) {
        console.log(`[NicheHunter] Skipping "${(hotSeller?.title ?? "").slice(0, 50)}" — category "${category}" already at ${MAX_PATTERNS_PER_CATEGORY} saved`);
        continue;
      }

      // Skip duplicates
      const srcTitle = (hotSeller?.title ?? "").toLowerCase().trim();
      const patName = (p.patternName ?? "").toLowerCase().trim();
      if (srcTitle && existingSourceTitles.has(srcTitle)) {
        console.log(`[NicheHunter] Skipping duplicate source: "${srcTitle.slice(0, 60)}"`);
        continue;
      }
      if (patName && existingPatternNames.has(patName)) {
        console.log(`[NicheHunter] Skipping duplicate pattern: "${patName.slice(0, 60)}"`);
        continue;
      }
      // Theme-fingerprint dedup (PO: respect Concept Library "winning designs").
      // Fingerprint = the niche CONCEPT (patternName) ONLY, NOT the source title. PO yield
      // fix 2026-06-10: title-based dedup blocked an ENTIRE source vein once one design from
      // it was approved (approving "Happy Camper→Happy Dinker" then deduped EVERY future
      // camping source), collapsing yield to ~1 — the cat-tee was the only un-mined vein.
      // Concept-based dedup lets one vein yield MULTIPLE distinct pickleball concepts; only a
      // repeated CONCEPT (Salty Dinker reused) dedups. Identical source LISTINGS are still
      // caught by the exact-title check above, so we never re-mine the same listing twice.
      const candidateFp = extractFingerprint(patName);
      const overlapIdx = existingFingerprints.findIndex(ef => sharesTheme(candidateFp, ef));
      if (overlapIdx >= 0) {
        const overlap = Array.from(candidateFp).filter(w => existingFingerprints[overlapIdx].has(w)).slice(0, 5);
        console.log(`[NicheHunter] Skipping "${srcTitle.slice(0, 60)}" — theme overlap with existing pattern (shared: ${overlap.join(", ")})`);
        continue;
      }
      if (srcTitle) existingSourceTitles.add(srcTitle);
      if (patName) existingPatternNames.add(patName);
      if (candidateFp.size > 0) existingFingerprints.push(candidateFp);

      // Determine adaptation mode
      const mode = determineAdaptationMode(hotSeller?.sourceImageUrl, sourceStyle);

      // Auto-dismiss gate
      const isTransferValid = p.transferValid !== false;
      const row = await createTrendPattern({
        workspaceId: workspace.id,
        scanId,
        sourcePlatform: "etsy",
        sourceTitle: hotSeller?.title ?? null,
        sourceUrl: hotSeller?.sourceUrl ?? null,
        sourceImageUrl: hotSeller?.sourceImageUrl ?? null,
        sourceSales: hotSeller?.estimatedSales ?? null,
        sourceBadge: hotSeller?.sourceBadge ?? null,
        sourceScrapedAt: new Date(),
        sourceReviewCount: hotSeller?.sourceReviewCount ?? null,
        sourceCategory: hotSeller?.category ?? null,
        patternName: p.patternName,
        composition: p.composition,
        colorStrategy: p.colorStrategy,
        emotionalHook: p.emotionalHook,
        transferablePattern: p.transferablePattern,
        whyItWorks: p.whyItWorks,
        adaptedConcept: p.adaptedConcept,
        transferValid: isTransferValid,
        transferReasoning: p.transferReasoning ?? null,
        status: isTransferValid ? "discovered" : "dismissed",
        // Style-Faithful Pipeline fields
        sourceStyleJson: sourceStyle as Record<string, unknown> | null,
        adaptationMode: mode,
        // Curated mode: mark "awaiting concept choice" ATOMICALLY at insert so the
        // background straggler-drain (retryStuckPatterns) can never auto-generate it
        // during the window before scan-end concept proposals are written.
        awaitingConcept: conceptMode === "curated",
      });

      if (isTransferValid) {
        saved++;
        savedPerCategory[category] = (savedPerCategory[category] ?? 0) + 1;
      } else {
        console.log(`[NicheHunter] Auto-dismissed pattern "${p.patternName}" — transfer invalid: ${p.transferReasoning}`);
        continue;
      }

      // Progress update
      const progress = 70 + Math.round((i / totalPatterns) * 25);
      await updateScanRun(scanId, { progress });

      // CURATED MODE (PO Option C): do NOT auto-generate. Concept options are
      // proposed in a parallel batch AFTER rank+score-gate (see below), and the
      // human picks one before any image is generated. Skip the production fire here.
      if (conceptMode === "curated") {
        continue;
      }

      // Generate production design: fire-and-forget so scan completes fast
      // Images trickle in as they complete — UI polls and shows them when ready
      const rowId = row.id;
      const workspaceId = workspace.id;
      const patternName = p.patternName;
      const adaptedConcept = p.adaptedConcept;
      const colorStrategy = p.colorStrategy;
      const sourceImageUrl = hotSeller?.sourceImageUrl ?? null;

      // Capture sourceStyle for async closure
      const capturedSourceStyle = sourceStyle;

      // Capture loop variables for async closure
      void (async () => {
        try {
          if (sourceImageUrl) {
            // Build a MINIMAL edit prompt from structured swap pairs.
            // Stress-test result: minimal "Replace X with Y." beats verbose "Keep everything else..." prompts.
            // The model already preserves everything not mentioned — no need to spell it out.
            const characterSwaps = p.characterSwaps ?? [];
            const contextSwaps = p.contextSwaps ?? [];

            // Build edit prompt from ALL available swap pairs (character + context combined)
            const parts: string[] = [];

            if (characterSwaps.length > 0) {
              // Character swap: "Replace the Star Trek captain with a pickleball server."
              parts.push(
                ...characterSwaps.map(s => `Replace the ${s.from} with a ${s.to}.`)
              );
            }
            if (contextSwaps.length > 0) {
              // Context/text swap: "Replace 'One Shirt' with 'One Dink'."
              parts.push(
                ...contextSwaps.map(s => `Replace "${s.from}" with "${s.to}".`)
              );
            }

            let editPrompt: string;
            if (parts.length > 0) {
              editPrompt = parts.join(" ");
            } else {
              // Fallback: no structured swaps available.
              // Convert adaptedConcept into an edit instruction rather than a bare description.
              editPrompt = `Replace the main subject with: ${adaptedConcept}.`;
            }

            console.log(`[NicheHunter] v2 pipeline (async) for pattern "${patternName.slice(0, 40)}" | editPrompt: "${editPrompt.slice(0, 100)}"`);
            await processPatternProduction(rowId, workspaceId, sourceImageUrl, editPrompt);
          } else {
            console.log(`[NicheHunter] No source image for pattern ${rowId}, using Forge prompt-only`);
            const payload = buildGenerationPayload(p, mode, undefined, sourceStyle, profile);
            const { url } = await generateImage(payload);
            if (url) await updateTrendPatternImage(rowId, url);
          }
        } catch (imgErr: any) {
          const errMsg = imgErr?.message ?? String(imgErr);
          const errStack = imgErr?.stack ?? '';
          console.error(`[NicheHunter] Image gen FAILED for pattern "${patternName}" (${rowId}): ${errMsg}`);
          console.error(`[NicheHunter] Stack: ${errStack.substring(0, 500)}`);
          // Non-fatal: pattern row already saved, productionDesignUrl will remain null
        }
      })();
    }

    // Step 5: Rank all patterns
    await updateScanRun(scanId, { progress: 96 });
    await rankPatterns(workspace.id, profile);

    // Step 5b: Score gate — applies ONLY in CURATED mode (pre-production). PO directive:
    // "nothing is auto-dismissed if produced." In AUTO mode the fire-and-forget image gen has
    // already run, so these designs are PRODUCED — and the rank score here graded the throwaway
    // SCAN-TIME draft concept, NOT what the image brain actually made (a literal 'pickleball
    // patch' draft routinely becomes a great 'llama playing pickleball'). Dismissing on that
    // stale score killed good output (PO-caught 2026-06-10: a llama-pickleball design auto-
    // dismissed at "rank 35"). So AUTO mode does NOT score-gate — the post-production validator
    // flags weak designs, the human curates, and the score is RE-GROUNDED on the real design in
    // processPatternProduction. CURATED mode IS pre-production (concept options only, no image
    // yet), so there the gate is a legitimate "catch before doing" and still applies.
    const LOW_FIT_THRESHOLD = 50;
    const allDiscovered = await getTrendPatternsByWorkspace(workspace.id, "discovered");
    const thisScanDiscovered = allDiscovered.filter(p => p.scanId === scanId);
    const lowFit = thisScanDiscovered.filter(p => (p.score ?? 100) < LOW_FIT_THRESHOLD);
    if (conceptMode === "curated") {
      for (const p of lowFit) {
        const reason = `Low fit (rank score ${p.score ?? 0}): ${p.rankReasoning ?? "no rationale recorded"}`;
        console.log(`[NicheHunter] Score gate (curated): auto-dismissing "${(p.patternName ?? "").slice(0, 40)}" — ${reason.slice(0, 80)}`);
        await updateTrendPatternStatus(p.id, "dismissed");
        await recordRejectionSignal(p.id, reason, ["off_brand"]);
      }
      if (lowFit.length > 0) {
        console.log(`[NicheHunter] Score gate: dismissed ${lowFit.length}/${thisScanDiscovered.length} patterns from scan ${scanId} (threshold ${LOW_FIT_THRESHOLD})`);
      }
    }

    // Step 5c: CURATED MODE — propose 2-3 concept OPTIONS per surviving pattern, in
    // PARALLEL batches (like style extraction), so the scan completes with all options
    // ready and the human can pick. Synchronous (awaited) — NOT fire-and-forget — there
    // is no retry mechanism for proposals, so they must finish inside the scan's lifetime.
    // No image is generated; that happens later via chooseConceptAndGenerate.
    if (conceptMode === "curated") {
      const survivors = thisScanDiscovered
        .filter(p => !lowFit.some(l => l.id === p.id) && p.sourceImageUrl);
      const dismissed = await getTrendPatternsByWorkspace(workspace.id, "dismissed");
      const avoidForProposals = aggregateAvoidList(dismissed);
      console.log(`[NicheHunter] Curated mode: proposing concepts for ${survivors.length} patterns`);
      const CONCURRENCY = 8;
      for (let i = 0; i < survivors.length; i += CONCURRENCY) {
        const batch = survivors.slice(i, i + CONCURRENCY);
        await Promise.all(batch.map(async (p) => {
          try {
            const options = await proposeConcepts(
              p.sourceImageUrl!, profile, p.sourceCategory ?? "the niche", "t-shirt", avoidForProposals
            );
            if (options.length > 0) await updateTrendPatternConceptOptions(p.id, options);
            else {
              // No clean conversion → dismiss so it doesn't sit option-less forever.
              await updateTrendPatternStatus(p.id, "dismissed");
              await recordRejectionSignal(p.id, "No clean pickleball concept could be proposed for this source.", ["off_brand"]);
            }
          } catch (e) {
            console.warn(`[NicheHunter] proposeConcepts failed for ${p.id} (non-fatal):`, e instanceof Error ? e.message : e);
          }
        }));
      }
    }

    await updateScanRun(scanId, {
      status: "completed",
      progress: 100,
      patternsFound: saved,
      completedAt: new Date(),
    });
  } catch (err) {
    await updateScanRun(scanId, {
      status: "failed",
      errorLog: err instanceof Error ? err.message : String(err),
      completedAt: new Date(),
    });
  }
}
