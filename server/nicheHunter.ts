/**
 * Niche Hunter Scan Engine — Phase E + Style-Faithful Pipeline
 *
 * Five steps per scan:
 *   Step 1: Real Etsy hot sellers (with LLM fallback)
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
import { extractStyleFromImage } from "./styleExtractor";
import type { SourceStyleJSON } from "../shared/sourceStyleJson";
import {
  createTrendPattern,
  updateScanRun,
  updateTrendPatternImage,
  updateTrendPatternScore,
  updateTrendPatternStyleData,
  getTrendPatternsByWorkspace,
} from "./nicheHunterDb";
import type { Workspace } from "../drizzle/schema";

// ─── Types ────────────────────────────────────────────────────────────────────

type AdaptationMode = "edit_source" | "style_reference" | "prompt_only";

type NicheProfile = {
  summary?: string;
  targetAudience?: string;
  subreddits?: string[];
  etsyKeywords?: string[];
  crossNicheCategories?: string[];
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

// ─── Step 1: Real Etsy hot sellers (with LLM fallback) ───────────────────────

interface HotSeller {
  title: string;
  category: string;
  estimatedSales: number;
  imageDescription: string;
  sourceUrl?: string;
  sourceImageUrl?: string;
}

/**
 * Fetch real top-selling Etsy listings from cross-niche categories ONLY.
 * NEVER searches the user's own niche — only other markets (hiking, camping, yoga, etc.).
 * Returns up to 2 listings per category. Falls back to LLM simulation if no API key.
 */
async function fetchCrossNicheHotSellers(
  crossNicheCategories: string[],
  etsyApiKey: string | undefined,
  _etsyKeywords?: string[]
): Promise<HotSeller[]> {
  // CRITICAL: Only search cross-niche categories (hiking, camping, yoga, fishing, etc.)
  // NEVER search the user's own niche keywords — the whole point is to find proven
  // designs in OTHER markets and transport the visual patterns.
  const categories = crossNicheCategories.slice(0, 8);

  // ── Source quality filters ─────────────────────────────────────────────────
  const MIN_FAVORITES = 500; // Only genuine best-sellers (Fixes Failure #1)
  const TITLE_BLOCKLIST = [ // Customizable products (Failure #4) + non-graphic shirts (Failure #7)
    "custom", "personalized", "customized", "personalised", "made to order",
    "your name", "your text", "add your",
    "polo", "performance", "hawaiian", "sublimation", "all over print",
    "allover", "full print", "jersey", "dri-fit", "moisture wicking",
    "embroidered", "embroidery",
  ];

  // ── Real Etsy path ──────────────────────────────────────────────────────────
  if (etsyApiKey) {
    const results: HotSeller[] = [];
    const seenTitles = new Set<string>();

    for (const category of categories) {
      try {
        const apparelTerms = ["shirt", "tee", "tshirt", "t-shirt", "hoodie", "sweatshirt", "tank"];
        const hasApparelTerm = apparelTerms.some(t => category.toLowerCase().includes(t));
        const searchQuery = hasApparelTerm ? `${category} graphic` : `${category} graphic shirt`;
        // Sort by score + best_seller flag to get genuinely high-volume cross-niche sellers
        const url = `https://openapi.etsy.com/v3/application/listings/active?keywords=${encodeURIComponent(searchQuery)}&limit=8&sort_on=score&is_best_seller=true`;
        const resp = await fetch(url, {
          headers: { "x-api-key": etsyApiKey },
          signal: AbortSignal.timeout(8000),
        });
        if (!resp.ok) {
          if (resp.status === 401 || resp.status === 403) {
            console.warn("[NicheHunter] Etsy API key invalid — falling back to LLM simulation");
            break;
          }
          continue;
        }
        const data = await resp.json();
        const listings: Record<string, unknown>[] = data.results ?? [];
        let addedForCategory = 0;
        for (const listing of listings) {
          if (addedForCategory >= 2) break;
          const rawTitle = ((listing.title as string) ?? "").trim();
          const title = rawTitle
            .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
            .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
            .slice(0, 120);
          if (!title || seenTitles.has(title.toLowerCase())) continue;

          // ── Fix #1: Minimum favorites gate (genuine best-sellers only) ──
          const favorites = (listing.num_favorers as number) ?? 0;
          if (favorites < MIN_FAVORITES) {
            console.log(`[NicheHunter] Skipping low-volume listing (${favorites} favs): "${title.slice(0, 50)}"`);
            continue;
          }

          // ── Fix #4 + #7: Title blocklist (no custom/polo/pattern products) ──
          const titleLower = title.toLowerCase();
          const blockedTerm = TITLE_BLOCKLIST.find(term => titleLower.includes(term));
          if (blockedTerm) {
            console.log(`[NicheHunter] Skipping blocked product type ("${blockedTerm}"): "${title.slice(0, 50)}"`);
            continue;
          }

          seenTitles.add(title.toLowerCase());
          const listingId = listing.listing_id as number;
          const slug = (listing.url as string | undefined) ?? `https://www.etsy.com/listing/${listingId}`;

          let imageUrl: string | null = null;
          try {
            const imgResp = await fetch(
              `https://openapi.etsy.com/v3/application/listings/${listingId}/images`,
              { headers: { "x-api-key": etsyApiKey }, signal: AbortSignal.timeout(5000) }
            );
            if (imgResp.ok) {
              const imgData = await imgResp.json();
              imageUrl = imgData.results?.[0]?.url_570xN ?? null;
            }
          } catch {
            // Image fetch failure is non-fatal
          }

          results.push({
            title,
            category,
            estimatedSales: Math.max(1, Math.round(favorites / 3)),
            imageDescription: `Etsy best seller: "${title.slice(0, 60)}" with ${favorites} favorites.`,
            sourceUrl: slug,
            sourceImageUrl: imageUrl ?? undefined,
          });
          addedForCategory++;
        }
        await new Promise((r) => setTimeout(r, 300));
      } catch (err) {
        console.warn(`[NicheHunter] Etsy fetch failed for category "${category}":`, err);
      }
    }

    if (results.length >= 4) {
      console.log(`[NicheHunter] Fetched ${results.length} real Etsy hot sellers`);
      return results;
    }
    console.warn(`[NicheHunter] Only ${results.length} real listings found — supplementing with LLM simulation`);
  }

  // ── LLM fallback ────────────────────────────────────────────────────────────
  const categoryList = categories.join(", ");
  const response = await invokeLLM({
    messages: [
      {
        role: "system",
        content: `You are an Etsy market research expert. Generate realistic top-selling Etsy graphic t-shirt listings from OTHER niches (NOT the user's own niche).
These must be genuinely high-volume sellers (500+ sales/month) from broad categories like hiking, camping, yoga, fishing, reading, gardening, nursing, etc.
Return ONLY valid JSON: an array of 8 objects, each with:
- title: string (realistic Etsy listing title for a graphic shirt in that niche)
- category: string (which cross-niche category this belongs to)
- estimatedSales: number (realistic monthly sales, 200-3000 — these are TOP sellers)
- imageDescription: string (describe the design visually in 2-3 sentences — exact composition, character poses/positions, text placement, art style, color palette)`,
      },
      {
        role: "user",
        content: `Generate 8 top-selling graphic t-shirt designs from these cross-niche categories (NOT pickleball, NOT the user's niche): ${categoryList}`,
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "hot_sellers",
        strict: true,
        schema: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              category: { type: "string" },
              estimatedSales: { type: "number" },
              imageDescription: { type: "string" },
            },
            required: ["title", "category", "estimatedSales", "imageDescription"],
            additionalProperties: false,
          },
        },
      },
    },
  });

  const content = response.choices?.[0]?.message?.content;
  const raw = typeof content === "string" ? content : (content as TextContent[])?.find(p => p.type === "text")?.text ?? null;
  if (!raw) return [];
  try {
    return JSON.parse(raw) as HotSeller[];
  } catch {
    return [];
  }
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
}

async function deconstructAndAdapt(
  hotSellers: HotSeller[],
  nicheSignals: NicheSignals,
  nicheProfile: NicheProfile
): Promise<DeconstructedPattern[]> {
  const sellersText = hotSellers
    .map((s, i) => `${i + 1}. "${s.title}" (${s.category}, ~${s.estimatedSales} sales/mo)\n   Design: ${s.imageDescription}`)
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
    culturalContext = parts.join("\n");
  }

  const response = await invokeLLM({
    messages: [
      {
        role: "system",
        content: `You are a print-on-demand design strategist. Your job is to:
1. Deconstruct why each hot-selling listing works (composition, color, emotional hook)
2. Extract the transferable design PATTERN (not the specific content)
3. Adapt that pattern for a completely different niche using the provided community signals AND cultural map

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

=== HARD CONSTRAINT: TARGET NICHE IS PICKLEBALL (Fix #2) ===
The ONLY target niche is PICKLEBALL. Every single adaptedConcept MUST be about pickleball.
NEVER adapt to another sport (soccer, basketball, tennis, etc.). If the source is bowling,
the adaptation is PICKLEBALL — not soccer, not tennis, not anything else.
===========================================

=== HARD CONSTRAINT: NO ELEMENT INJECTION (Fix #5) ===
The adaptedConcept must contain ONLY elements that exist in the source design:
- If the source has NO animals → the adaptation must have NO animals (ignore animalMascots from cultural map)
- If the source has NO text/slogan → the adaptation must have NO text/slogan
- If the source has 3 characters → the adaptation must have exactly 3 characters
- The cultural map is for VOCABULARY and CONTEXT only — NEVER inject new visual elements from it
===========================================

=== HARD CONSTRAINT: NO TEXT INJECTION (Fix #9) ===
- If the source design has NO text/words/slogans, the adaptedConcept must describe a design with NO text.
- DO NOT invent slogans like "pickleball is my therapy" or "I'd rather be dinking" unless the source already had a slogan.
- If the source HAS text, replace it with pickleball-equivalent text of the SAME length and position.
===========================================

=== HARD CONSTRAINT: PICKLEBALL-SPECIFIC VOCABULARY (Fix #8) ===
When text IS present in the source and needs adaptation, use ONLY pickleball-specific terms:
- GOOD: dink, kitchen, third shot drop, paddle, volley, erne, ATP, stacking, skinny singles, NVZ, drop shot, rally, bangers, dinkers
- BAD: generic sports phrases like "find your zen on the court", "game day", "love the game" — these apply to ANY sport
Every adapted phrase must be UNMISTAKABLY about pickleball to someone who has never seen the source.
===========================================

Return ONLY valid JSON: an array of objects, one per hot seller analyzed.`,
      },
      {
        role: "user",
        content: `TARGET NICHE: ${nicheProfile.summary ?? ""}
Audience: ${nicheProfile.targetAudience ?? ""}

COMMUNITY SIGNALS:
${signalsText}

CULTURAL MAP (use these for richer, niche-specific adaptations):
${culturalContext || "Not available — use community signals only"}

HOT SELLERS TO DECONSTRUCT:
${sellersText}

Deconstruct each hot seller and adapt it for the target niche. Use the cultural map to make adaptations feel authentic and insider-y.`,
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
            },
            required: [
              "patternName", "composition", "colorStrategy", "emotionalHook",
              "transferablePattern", "whyItWorks", "adaptedConcept",
              "transferValid", "transferReasoning",
            ],
            additionalProperties: false,
          },
        },
      },
    },
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
 * Build an image generation prompt and optional originalImages for a pattern.
 * Returns { prompt, originalImages } ready for generateImage().
 */
function buildGenerationPayload(
  pattern: DeconstructedPattern,
  mode: AdaptationMode,
  sourceImageUrl: string | undefined,
  sourceStyle: SourceStyleJSON | null
): { prompt: string; originalImages?: Array<{ url: string; mimeType: string }> } {
  const baseSubject = pattern.adaptedConcept;
  const composition = pattern.composition;

  if (mode === "edit_source" && sourceImageUrl && sourceStyle) {
    // Highest fidelity: edit the source image — ONLY swap the subject/activity.
    // HARD CONSTRAINTS: preserve exact layout, grid positions, text placement, art style.
    const styleDesc = [
      `Technique: ${sourceStyle.technique}`,
      `Line weight: ${sourceStyle.lineWeight}`,
      `Shading: ${sourceStyle.shadingMethod}`,
      `Texture: ${sourceStyle.textureDetail}`,
      `Colors: ${sourceStyle.inkColors.join(", ")}`,
      `Composition: ${sourceStyle.composition}`,
      `Framing: ${sourceStyle.framingDevice !== "NONE" ? sourceStyle.framingDevice : "none"}`,
      `Text style: ${sourceStyle.textStyle !== "NONE" ? sourceStyle.textStyle : "none"}`,
      `Design era: ${sourceStyle.designEra}`,
    ].join(". ");

    const prompt = [
      `Edit this t-shirt design. HARD RULES — you MUST follow ALL of these:`,
      ``,
      `1. KEEP the EXACT same layout — same number of visual elements in the SAME positions.`,
      `2. KEEP the EXACT same text placement — title position, subtitle position, font style.`,
      `3. KEEP the EXACT same art style: ${styleDesc}.`,
      `4. KEEP the EXACT same color palette and background treatment.`,
      `5. ONLY change the SUBJECT/ACTIVITY depicted. If the source shows cats doing yoga poses, change them to cats doing PICKLEBALL poses in the SAME grid positions.`,
      `6. The new subject/activity is: ${baseSubject}.`,
      ``,
      `=== ABSOLUTE PROHIBITIONS ===`,
      `7. DO NOT add any text, words, or slogans that are NOT in the original design. If the source has no text, output must have no text.`,
      `8. DO NOT add any animals, characters, or visual elements that are NOT in the original design.`,
      `9. If the source has a signature, watermark, or artist mark at the bottom, REMOVE it entirely. Do not copy or adapt it.`,
      `10. The ONLY change is: replace the depicted activity/subject with pickleball. Nothing else changes.`,
      ``,
      `Think of this as a find-and-replace on the ACTIVITY only. Everything else stays pixel-identical in layout.`,
      `Output: transparent background, print-ready art, no shirt visible.`,
    ].join("\n");

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

// ─── Main scan orchestrator ───────────────────────────────────────────────────

const MAX_PATTERNS_PER_SCAN = 8;

export async function runNicheHunterScan(
  workspace: Workspace,
  scanId: string,
  etsyApiKey?: string
): Promise<void> {
  const profile = (workspace.nicheProfile ?? {}) as NicheProfile;
  const crossNicheCategories = profile.crossNicheCategories ?? [];
  const etsyKeywords = profile.etsyKeywords ?? [];
  const subreddits = profile.subreddits ?? [];

  try {
    // Step 1: Real Etsy hot sellers (with LLM fallback)
    await updateScanRun(scanId, { progress: 10 });
    const hotSellers = await fetchCrossNicheHotSellers(crossNicheCategories, etsyApiKey, etsyKeywords);
    await updateScanRun(scanId, { progress: 20 });

    // Step 1b: Style extraction from source images (Vision LLM, non-blocking per listing)
    console.log(`[NicheHunter] Extracting styles from ${hotSellers.filter(s => s.sourceImageUrl).length} source images...`);
    const sourceStyles = await extractStylesForHotSellers(hotSellers);
    await updateScanRun(scanId, { progress: 35 });

    // Step 2: In-niche Reddit signals
    const nicheSignals = await extractInNicheSignals(subreddits, profile);
    await updateScanRun(scanId, { progress: 50 });

    // Steps 3+4: Deconstruct + adapt (cultural map aware)
    const patterns = await deconstructAndAdapt(hotSellers, nicheSignals, profile);
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

      // Generate preview image using three-mode generation
      try {
        const payload = buildGenerationPayload(p, mode, hotSeller?.sourceImageUrl, sourceStyle);
        console.log(`[NicheHunter] Generating image (mode: ${mode}) for pattern "${p.patternName.slice(0, 40)}"`);
        const { url } = await generateImage(payload);
        if (url) {
          await updateTrendPatternImage(row.id, url);
        }
      } catch (imgErr) {
        console.warn(`[NicheHunter] Image gen failed for pattern ${row.id}:`, imgErr);
      }
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
