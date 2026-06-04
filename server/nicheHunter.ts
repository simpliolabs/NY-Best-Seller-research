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
} from "./etsyScraper";
import { selectGraphicTeeTiles } from "./visionTileSelector";
import type { SourceStyleJSON } from "../shared/sourceStyleJson";
import {
  createTrendPattern,
  updateScanRun,
  updateTrendPatternImage,
  updateTrendPatternScore,
  updateTrendPatternStyleData,
  getTrendPatternsByWorkspace,
} from "./nicheHunterDb";
import { processPatternProduction } from "./patternProductionProcessor";
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
async function fetchCrossNicheHotSellers(
  crossNicheCategories: string[],
  _etsyApiKey?: string,       // retained for signature compatibility; unused
  _etsyKeywords?: string[],
  generalBestSellerTerms?: string[]
): Promise<{ sellers: HotSeller[]; instrumentation: SourceInstrumentation; searchLog: Array<{ query: string; url: string; filter: "is_best_seller" | "is_popular_now"; resultCount: number; searchedAt: string }> }> {
  // Prepend general best-seller terms BEFORE cross-niche categories
  // Cap general terms at 2 (1-2 broad market searches, not the whole list)
  // Total category budget: 8 (2 general + 6 cross-niche) — keeps scan under 10 min
  const generalTerms = (generalBestSellerTerms ?? []).slice(0, 2);
  const crossNiche = crossNicheCategories.slice(0, 8 - generalTerms.length);
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

  await openBrowser();

  try {
    // ── Pass 1: is_best_seller ──────────────────────────────────────────────
    const pass1Counts: Record<string, number> = {};

    for (const category of categories) {
      // Use the category term directly as the Etsy search query.
      // The is_best_seller filter does the heavy lifting — no need to append
      // "graphic" or "graphic shirt" which makes queries unnatural and too narrow.
      // The vision LLM downstream filters for graphic tee tiles from the results.
      const searchQuery = category;

      const searchResult = await fetchEtsySearchPage(searchQuery, "is_best_seller");
      const encodedQ1 = encodeURIComponent(searchQuery);
      searchLog.push({
        query: searchQuery,
        url: `https://www.etsy.com/search?q=${encodedQ1}&explicit=1&is_best_seller=true`,
        filter: "is_best_seller",
        resultCount: searchResult.tiles.length,
        searchedAt: new Date().toISOString(),
      });

      if (searchResult.scraperBroken) {
        // SCRAPER_BROKEN: Etsy HTML structure changed — fail the entire scan with a distinct error
        instrumentation.mode = "scraper_broken";
        instrumentation.fallbackReason = searchResult.errorMessage;
        console.error(`[NicheHunter] ⛔ SCRAPER_BROKEN for category "${category}": ${searchResult.errorMessage}`);
        // Return immediately — no partial results, no fiction
        return { sellers: [], instrumentation, searchLog };
      }

      if (!searchResult.pageRendered) {
        console.warn(`[NicheHunter][CATEGORY] "${category}" → Page not rendered: ${searchResult.errorMessage}`);
        instrumentation.httpErrors.push({ category, status: 0, message: searchResult.errorMessage ?? "Page not rendered" });
        pass1Counts[category] = 0;
        continue;
      }

      if (searchResult.tiles.length === 0) {
        console.log(`[NicheHunter][CATEGORY] "${category}" → 0 tiles from scraper (pass 1)`);
        pass1Counts[category] = 0;
        continue;
      }

      // Vision LLM selection
      const { selectedIds, rejectionNotes } = await selectGraphicTeeTiles(category, searchResult.tiles);
      console.log(`[NicheHunter][CATEGORY] "${category}" (pass 1) → scraped=${searchResult.tiles.length} | selected=${selectedIds.length} | notes: ${rejectionNotes.slice(0, 80)}`);

      let addedForCategory = 0;
      for (const tile of searchResult.tiles) {
        if (!selectedIds.includes(tile.listingId)) continue;
        if (seenListingIds.has(tile.listingId)) continue;
        seenListingIds.add(tile.listingId);
        results.push({
          title: tile.title,
          category,
          estimatedSales: tile.reviewCount,
          imageDescription: "",
          sourceUrl: tile.listingUrl,
          sourceImageUrl: tile.fullResUrl,
          sourceReviewCount: tile.reviewCount,
          sourceBadge: tile.badge,
        });
        addedForCategory++;
      }
      pass1Counts[category] = addedForCategory;
    }

    // ── Pass 2: is_popular_now for categories that yielded < 2 tiles ──────
    const pass2Categories = categories.filter(c => (pass1Counts[c] ?? 0) < 2);
    if (pass2Categories.length > 0) {
      console.log(`[NicheHunter] Pass 2 (popular_now) for ${pass2Categories.length} starved categories: ${pass2Categories.join(", ")}`);
      for (const category of pass2Categories) {
        // Same as pass 1 — use category directly, no graphic suffix
        const searchQuery = category;

        const searchResult = await fetchEtsySearchPage(searchQuery, "is_popular_now");
        const encodedQ2 = encodeURIComponent(searchQuery);
        searchLog.push({
          query: searchQuery,
          url: `https://www.etsy.com/search?q=${encodedQ2}&explicit=1&is_popular_now=true`,
          filter: "is_popular_now",
          resultCount: searchResult.tiles.length,
          searchedAt: new Date().toISOString(),
        });

        if (searchResult.scraperBroken) {
          instrumentation.mode = "scraper_broken";
          instrumentation.fallbackReason = searchResult.errorMessage;
          console.error(`[NicheHunter] ⛔ SCRAPER_BROKEN (pass 2) for "${category}": ${searchResult.errorMessage}`);
          return { sellers: [], instrumentation, searchLog };
        }

        if (!searchResult.pageRendered || searchResult.tiles.length === 0) {
          console.log(`[NicheHunter][CATEGORY] "${category}" → 0 tiles from scraper (pass 2)`);
          continue;
        }

        const { selectedIds, rejectionNotes } = await selectGraphicTeeTiles(category, searchResult.tiles);
        console.log(`[NicheHunter][CATEGORY] "${category}" (pass 2) → scraped=${searchResult.tiles.length} | selected=${selectedIds.length} | notes: ${rejectionNotes.slice(0, 80)}`);

        for (const tile of searchResult.tiles) {
          if (!selectedIds.includes(tile.listingId)) continue;
          if (seenListingIds.has(tile.listingId)) continue;
          seenListingIds.add(tile.listingId);
          results.push({
            title: tile.title,
            category,
            estimatedSales: tile.reviewCount,
            imageDescription: "",
            sourceUrl: tile.listingUrl,
            sourceImageUrl: tile.fullResUrl,
            sourceReviewCount: tile.reviewCount,
            sourceBadge: tile.badge,
          });
        }
      }
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
 */
async function extractStylesForHotSellers(
  hotSellers: HotSeller[]
): Promise<(SourceStyleJSON | null)[]> {
  const results: (SourceStyleJSON | null)[] = [];
  for (const seller of hotSellers) {
    if (seller.sourceImageUrl) {
      const style = await extractStyleFromImage(seller.sourceImageUrl);
      results.push(style);
    } else {
      results.push(null);
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
 *   2. Auto-derived from workspace product groups (productType field → search terms)
 *   3. Default fallback for graphic tee businesses
 */
async function resolveGeneralBestSellerTerms(
  profile: NicheProfile,
  workspaceId: string
): Promise<string[]> {
  // Priority 1: Explicit user-configured terms
  if (profile.generalBestSellerTerms && profile.generalBestSellerTerms.length > 0) {
    return profile.generalBestSellerTerms;
  }

  // Priority 2: Derive from product groups
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

  // Priority 3: Default for graphic tee businesses
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

// Reduced to 3 for fast first-result time (~5-8 min total scan)
// Increase back to 8 when ready for production volume
const MAX_PATTERNS_PER_SCAN = 3;

export async function runNicheHunterScan(
  workspace: Workspace,
  scanId: string,
  etsyApiKey?: string
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

  try {
    // Step 1: Real Etsy hot sellers (scrape-based, no fallback, no fiction)
    await updateScanRun(scanId, { progress: 10 });
    const { sellers: hotSellers, instrumentation, searchLog } = await fetchCrossNicheHotSellers(crossNicheCategories, etsyApiKey, etsyKeywords, generalTerms);
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

    // Cross-scan deduplication
    const existingPatterns = await getTrendPatternsByWorkspace(workspace.id);
    const existingSourceTitles = new Set(
      existingPatterns.map(ep => (ep.sourceTitle ?? "").toLowerCase().trim()).filter(Boolean)
    );
    const existingPatternNames = new Set(
      existingPatterns.map(ep => (ep.patternName ?? "").toLowerCase().trim()).filter(Boolean)
    );

    let saved = 0;
    const totalPatterns = Math.min(patterns.length, hotSellers.length);

    for (let i = 0; i < totalPatterns; i++) {
      // Hard cap: max 8 patterns per scan
      if (saved >= MAX_PATTERNS_PER_SCAN) {
        console.log(`[NicheHunter] Reached ${MAX_PATTERNS_PER_SCAN}-pattern cap — stopping`);
        break;
      }

      const p = patterns[i];
      const hotSeller = hotSellers[i];
      const sourceStyle = sourceStyles[i] ?? null;

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
      if (srcTitle) existingSourceTitles.add(srcTitle);
      if (patName) existingPatternNames.add(patName);

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
      });

      if (isTransferValid) saved++;
      else {
        console.log(`[NicheHunter] Auto-dismissed pattern "${p.patternName}" — transfer invalid: ${p.transferReasoning}`);
        continue;
      }

      // Progress update
      const progress = 70 + Math.round((i / totalPatterns) * 25);
      await updateScanRun(scanId, { progress });

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
