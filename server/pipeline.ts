/**
 * 7-Stage AI Pipeline for NYT Book Design Trend Analysis (v2)
 *
 * Stage 1: Ingest NYT Best Sellers data
 * Stage 2: Extract book metadata + fan culture via LLM
 * Stage 3: Book Niche Research — cultural insights per book
 * Stage 4: Generate 5 design concepts per book (niche-informed)
 * Stage 5: Score concepts + Etsy market validation
 * Stage 6: Design expansion + AI image generation for high scorers
 * Stage 7: Report delivery + notifyOwner
 */
import { invokeLLM } from "./_core/llm";
import { generateImage } from "./_core/imageGeneration";
import { notifyOwner } from "./_core/notification";
import { processDesignForProduction } from "./productionImageProcessor";
import { withSelfHeal, withCircuitBreaker, logHealingAction, classifyError } from "./selfHeal";
import {
  createRun,
  updateRunStage,
  completeRun,
  failRun,
  insertBooks,
  upsertBooksByIsbn,
  getBooksByIds,
  getBooksByRunId,
  updateBookExtraction,
  updateBookScores,
  updateBookForumSignals,
  insertConcept,
  getConceptsByRunId,
  insertNicheResearch,
  getNicheResearchByRunId,
  insertMarketValidation,
  updateConceptImages,
  updateConceptScore,
  updateRunImagesGenerated,
  updateRunBooksProcessed,
  getRunById,
  getPreviousCompletedRunId,
  getBooksByRunIdIndexedByIsbn,
  updateBookTrend,
  updateRunHeartbeat,
  updateConceptSignalTags,
  getConceptsByBookId,
} from "./db";
import type { InsertBook, InsertDesignConcept } from "../drizzle/schema";
import { scrapeAllForums, computeForumScore, extractCrossSourceSignals, type ForumSignals, type CrossSourceSignal } from "./forumScraper";
import type { NicheProfile } from "./onboardingRouter";

const NYT_API_BASE = "https://api.nytimes.com/svc/books/v3";
const NYT_LISTS = [
  "combined-print-and-e-book-fiction",
  "trade-fiction-paperback",
];
const TOP_N_BOOKS = 6;
const HIGH_SCORE_THRESHOLD = 210; // 70% of 300
const MAX_WINNER_CONCEPTS = 5; // Top 5 concepts GLOBALLY across all books get images
const IMAGES_PER_WINNER = 3; // 3 style variations per winner = 15 images max
const IMAGE_GEN_TIMEOUT_MS = 60_000; // 60s timeout per image generation call
const OVERALL_PIPELINE_TIMEOUT_MS = 7 * 60 * 1000; // 7 minute overall pipeline timeout (more images now)

// ─── Utility: Timeout wrapper ────────────────────────────────────────────

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timeout after ${ms}ms: ${label}`)),
      ms
    );
    promise
      .then((val) => { clearTimeout(timer); resolve(val); })
      .catch((err) => { clearTimeout(timer); reject(err); });
  });
}

// ─── Stage 1: Ingest ──────────────────────────────────────────────────────

type RawBook = {
  title: string;
  author: string;
  isbn: string;
  coverUrl: string;
  synopsis: string;
  rank: number;
  weeksOnList: number;
};

async function stageIngest(nytApiKey: string): Promise<RawBook[]> {
  const allBooks: RawBook[] = [];
  const seenIsbns = new Set<string>();

  for (const listName of NYT_LISTS) {
    const url = `${NYT_API_BASE}/lists/current/${listName}.json?api-key=${nytApiKey}`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!resp.ok) {
      console.warn(`[Pipeline] NYT API error for ${listName}: ${resp.status}`);
      continue;
    }
    const data = await resp.json();
    const booksData = data?.results?.books ?? [];

    for (const b of booksData) {
      const isbn = b.primary_isbn13 ?? "";
      if (!isbn || seenIsbns.has(isbn)) continue;
      seenIsbns.add(isbn);

      allBooks.push({
        title: (b.title ?? "").trim(),
        author: (b.author ?? "").trim(),
        isbn,
        coverUrl: b.book_image ?? "",
        synopsis: (b.description ?? "").trim(),
        rank: b.rank ?? 0,
        weeksOnList: b.weeks_on_list ?? 0,
      });

      if (allBooks.length >= TOP_N_BOOKS) break;
    }
    if (allBooks.length >= TOP_N_BOOKS) break;

    // Rate limit between list calls
    await new Promise((r) => setTimeout(r, 1200));
  }

  if (allBooks.length === 0) {
    throw new Error("No books returned from NYT API. Check your API key.");
  }

  return allBooks.slice(0, TOP_N_BOOKS);
}

// ─── Stage 1b: Niche Ingest (for niche_hunter workspaces) ───────────────────
// Replaces stageIngest for niche_hunter workspaces.
// Sources trending signals from Reddit (via LLM analysis of niche subreddits)
// and Etsy (in-niche bestseller keywords), then maps them to RawBook[] shape
// so Stages 2-7 work identically for both workspace types.

const NICHE_REDDIT_SYSTEM = `You are a Reddit community analyst specializing in print-on-demand merchandise opportunities. Analyze a list of niche-specific subreddits and identify the top trending topics that would make great t-shirt or merch designs.

For each subreddit community, identify what's currently resonating with members: inside jokes, identity phrases, pain points they laugh about, community milestones, and cultural moments.

Return a JSON object with a "topics" array of trending design topics. Each topic should feel like something a community member would proudly wear.

OUTPUT SCHEMA:
{
  "topics": [
    {
      "title": "string — the trending topic or phrase (2-6 words)",
      "synopsis": "string — 2-3 sentences explaining why this resonates with the community, what the inside joke/reference is, and why it would work on merch",
      "subreddit": "string — the subreddit this came from",
      "rank": "number — relevance rank 1-10 (10 = strongest signal)"
    }
  ]
}

RULES:
1. Topics must be SPECIFIC to this niche — not generic humor.
2. Prioritize phrases fans actually use, not invented ones.
3. Return 3-5 topics total across all subreddits.
4. Return ONLY the JSON object.`;

const NICHE_ETSY_SYSTEM = `You are an Etsy market analyst specializing in print-on-demand merchandise. Analyze a list of in-niche Etsy search keywords and identify the top-selling design themes.

For each keyword, identify what types of designs are bestsellers: what phrases they use, what visual styles dominate, what price points work, and what makes them stand out.

Return a JSON object with a "topics" array of bestselling design themes.

OUTPUT SCHEMA:
{
  "topics": [
    {
      "title": "string — the bestselling design theme or phrase (2-6 words)",
      "synopsis": "string — 2-3 sentences describing the design style, buyer motivation, and why it sells well in this niche",
      "keyword": "string — the Etsy keyword this came from",
      "rank": "number — commercial strength rank 1-10 (10 = strongest seller)"
    }
  ]
}

RULES:
1. Focus on designs that are actually selling, not just popular searches.
2. Identify the specific phrases and visual formulas that work.
3. Return 3-5 topics total across all keywords.
4. Return ONLY the JSON object.`;

async function stageNicheIngest(nicheProfile: NicheProfile, etsyApiKey?: string): Promise<RawBook[]> {
  const signals: RawBook[] = [];
  const seenTitles = new Set<string>();

  // Step 1: Reddit signal analysis via LLM (Reddit blocks server-side requests,
  // so we use LLM analysis of the niche subreddits — same pattern as forumScraper)
  if (nicheProfile.subreddits && nicheProfile.subreddits.length > 0) {
    try {
      const redditResult = await withTimeout(
        invokeLLM({
          messages: [
            { role: "system", content: NICHE_REDDIT_SYSTEM },
            { role: "user", content: `Niche: ${nicheProfile.summary}\nTarget audience: ${nicheProfile.targetAudience}\nSubreddits to analyze: ${nicheProfile.subreddits.join(", ")}\nCultural moments: ${nicheProfile.culturalMoments?.join(", ") ?? "none"}` },
          ],
          response_format: { type: "json_object" },
        }),
        30_000,
        "Niche Reddit analysis"
      );
      const content = typeof redditResult.choices[0]?.message?.content === "string"
        ? redditResult.choices[0].message.content : "{}";
      const parsed = JSON.parse(content);
      const topics = Array.isArray(parsed.topics) ? parsed.topics : [];
      for (const t of topics) {
        const title = (t.title ?? "").trim();
        if (!title || seenTitles.has(title.toLowerCase())) continue;
        seenTitles.add(title.toLowerCase());
        signals.push({
          title,
          author: `Reddit: ${t.subreddit ?? "niche community"}`,
          isbn: `niche-reddit-${Buffer.from(title).toString("base64").slice(0, 12)}`,
          coverUrl: "",
          synopsis: t.synopsis ?? "",
          rank: t.rank ?? 5,
          weeksOnList: 0,
        });
      }
      console.log(`[Pipeline/NicheIngest] Reddit analysis: ${topics.length} topics found`);
    } catch (err) {
      console.warn("[Pipeline/NicheIngest] Reddit analysis failed:", err);
    }
  }

  // Step 2: Etsy in-niche keyword analysis
  // If Etsy API is available, fetch real bestsellers; otherwise use LLM analysis
  if (nicheProfile.etsyKeywords && nicheProfile.etsyKeywords.length > 0) {
    let etsyTopics: Array<{ title: string; synopsis: string; rank: number }> = [];

    if (etsyApiKey) {
      // Real Etsy API: fetch top listings for each keyword
      for (const keyword of nicheProfile.etsyKeywords.slice(0, 5)) {
        try {
          const url = `https://openapi.etsy.com/v3/application/listings/active?keywords=${encodeURIComponent(keyword)}&limit=10&sort_on=score`;
          const resp = await fetch(url, {
            headers: { "x-api-key": etsyApiKey },
            signal: AbortSignal.timeout(8000),
          });
          if (!resp.ok) {
            if (resp.status === 401 || resp.status === 403) break; // Key invalid — stop all Etsy calls
            continue;
          }
          const data = await resp.json();
          const results = data.results ?? [];
          for (const listing of results.slice(0, 3)) {
            const title = (listing.title ?? "").trim().slice(0, 80);
            if (!title || seenTitles.has(title.toLowerCase())) continue;
            seenTitles.add(title.toLowerCase());
            const favorites = listing.num_favorers ?? 0;
            etsyTopics.push({
              title,
              synopsis: `Bestselling Etsy listing in "${keyword}" niche with ${favorites} favorites. Price: $${((listing.price?.amount ?? 0) / (listing.price?.divisor ?? 100)).toFixed(2)}. Tags: ${(listing.tags ?? []).slice(0, 5).join(", ")}.`,
              rank: Math.min(10, Math.max(1, Math.round(favorites / 50))),
            });
          }
          await new Promise((r) => setTimeout(r, 250)); // Etsy rate limit
        } catch (err) {
          console.warn(`[Pipeline/NicheIngest] Etsy fetch failed for "${keyword}":`, err);
        }
      }
    }

    // If no Etsy results (API unavailable or returned nothing), use LLM analysis
    if (etsyTopics.length === 0) {
      try {
        const etsyResult = await withTimeout(
          invokeLLM({
            messages: [
              { role: "system", content: NICHE_ETSY_SYSTEM },
              { role: "user", content: `Niche: ${nicheProfile.summary}\nEtsy keywords to analyze: ${nicheProfile.etsyKeywords.join(", ")}\nDesign styles that work: ${nicheProfile.designStyles?.join(", ") ?? "various"}` },
            ],
            response_format: { type: "json_object" },
          }),
          30_000,
          "Niche Etsy analysis"
        );
        const content = typeof etsyResult.choices[0]?.message?.content === "string"
          ? etsyResult.choices[0].message.content : "{}";
        const parsed = JSON.parse(content);
        etsyTopics = Array.isArray(parsed.topics) ? parsed.topics : [];
        console.log(`[Pipeline/NicheIngest] Etsy LLM analysis: ${etsyTopics.length} topics found`);
      } catch (err) {
        console.warn("[Pipeline/NicheIngest] Etsy LLM analysis failed:", err);
      }
    }

    for (const t of etsyTopics) {
      const title = (t.title ?? "").trim();
      if (!title || seenTitles.has(title.toLowerCase())) continue;
      seenTitles.add(title.toLowerCase());
      signals.push({
        title,
        author: "Etsy: in-niche bestseller",
        isbn: `niche-etsy-${Buffer.from(title).toString("base64").slice(0, 12)}`,
        coverUrl: "",
        synopsis: t.synopsis ?? "",
        rank: t.rank ?? 5,
        weeksOnList: 0,
      });
    }
  }

  if (signals.length === 0) {
    throw new Error("No niche signals found from Reddit or Etsy. Check the workspace niche profile.");
  }

  // Sort by rank descending, take top N
  return signals.sort((a, b) => b.rank - a.rank).slice(0, TOP_N_BOOKS);
}

// ─── Stage 2: Extract + Fan Culture ──────────────────────────────────────

const EXTRACTION_SYSTEM = `You are a book design analyst specializing in print-on-demand merchandise. Analyze a book's synopsis and metadata to extract structured aesthetic, thematic, and fan community data.

Given a book's title, author, and synopsis, extract the following fields and return them as a single JSON object. Do NOT include any text outside the JSON.

REQUIRED OUTPUT SCHEMA:
{
  "subgenre": "string — the specific genre/subgenre (e.g., 'dark romance', 'literary fiction', 'fantasy romance', 'cozy mystery')",
  "mood": "string — the dominant emotional mood (e.g., 'brooding', 'whimsical', 'tense', 'hopeful')",
  "setting": "string — the primary setting (e.g., 'modern New York', 'medieval fantasy kingdom')",
  "dominant_colors": ["string — 4-5 hex color codes that represent this book's visual identity based on mood and themes"],
  "visual_motifs": ["string — 3-5 visual symbols associated with the book's themes"],
  "typography_style": "string — recommended typography style (e.g., 'elegant serif', 'bold sans-serif', 'hand-lettered script')",
  "fan_culture": "string — 2-3 sentence summary of this book's fan community identity: who they are, how they identify, what makes them distinct as a group. Think about what a fan of this book would proudly wear on a t-shirt."
}

RULES:
1. The dominant_colors should reflect the MOOD and THEMES, not literal cover colors.
2. The visual_motifs should be symbolic, not literal scene descriptions.
3. The subgenre should be as specific as possible.
4. The fan_culture field should describe the community, not the book plot.
5. Return ONLY the JSON object. No markdown, no explanation, no preamble.`;

async function stageExtract(
  bookRecords: { id: number; title: string; author: string; synopsis: string | null }[]
): Promise<void> {
  // Parallel extraction — all books at once instead of sequential
  await Promise.allSettled(
    bookRecords.map(async (book) => {
      const userMsg = `Title: ${book.title}\nAuthor: ${book.author}\nSynopsis: ${book.synopsis ?? "No synopsis available."}`;

      try {
        const result = await withTimeout(
          invokeLLM({
            messages: [
              { role: "system", content: EXTRACTION_SYSTEM },
              { role: "user", content: userMsg },
            ],
            response_format: { type: "json_object" },
          }),
          30_000,
          `Extract "${book.title}"`
        );

        const content = typeof result.choices[0]?.message?.content === "string"
          ? result.choices[0].message.content
          : "";
        const parsed = JSON.parse(content);

        await updateBookExtraction(book.id, {
          subgenre: parsed.subgenre ?? null,
          mood: parsed.mood ?? null,
          setting: parsed.setting ?? null,
          dominantColors: parsed.dominant_colors ?? null,
          visualMotifs: parsed.visual_motifs ?? null,
          typographyStyle: parsed.typography_style ?? null,
          fanCulture: parsed.fan_culture ?? null,
        });
      } catch (err) {
        console.warn(`[Pipeline] Extraction failed for "${book.title}":`, err);
      }
    })
  );
}

// ─── Stage 2b: World Bible Extraction ───────────────────────────────────────

const WORLD_BIBLE_SYSTEM = `You are a visual development artist and IP world-builder. Your job is to extract the definitive visual universe of a book so a senior graphic designer can create t-shirt designs that feel like they came FROM inside the book's world — not just inspired by it.

Given a book's title, author, synopsis, mood, setting, and subgenre, extract the following 8 fields and return them as a single JSON object. Do NOT include any text outside the JSON.

REQUIRED OUTPUT SCHEMA:
{
  "illustrator_style": "string — the dominant visual art style of this book's world (e.g., 'gothic woodcut illustration', 'neon cyberpunk line art', 'soft watercolor romanticism', 'gritty urban realism')",
  "key_visual_environments": ["string — 3-5 specific physical environments from this book's world that fans would immediately recognize (e.g., 'the Midnight Library', 'the Hunger Games arena', 'the Overlook Hotel lobby')"],
  "key_objects": ["string — 4-6 iconic objects, weapons, symbols, or artifacts from this book that fans associate with it (e.g., 'the golden compass', 'the sorting hat', 'the red door')"],
  "lighting_signature": "string — the characteristic lighting that defines this book's visual mood (e.g., 'candlelit amber warmth', 'cold neon glow on wet streets', 'harsh desert midday sun', 'diffused forest dapple')",
  "texture_language": "string — the dominant texture vocabulary of this world (e.g., 'cracked leather and aged parchment', 'smooth chrome and frosted glass', 'rough linen and hand-stitched seams', 'weathered wood and rust')",
  "typography_native": "string — the typography style that feels native to this world (e.g., 'hand-engraved serif with flourishes', 'stencil military block caps', 'elegant Edwardian script', 'distressed grunge sans-serif')",
  "emotional_tone": "string — the dominant emotional register of this book's visual world (e.g., 'melancholic and yearning', 'darkly comedic and irreverent', 'epic and awe-inspiring', 'cozy and intimate')",
  "color_anchors": ["string — 4-6 specific hex color codes that are NATIVE to this book's visual world — not just mood colors, but colors that would appear in actual scenes, costumes, or environments"]
}

RULES:
1. Every field must be specific to THIS book's world, not generic genre tropes.
2. key_objects must be things fans would immediately recognize as belonging to this specific book.
3. color_anchors must feel like they were pulled from a scene in the book, not a mood board.
4. illustrator_style should name a real art movement or technique, not just a vibe.
5. Return ONLY the JSON object. No markdown, no explanation, no preamble.`;

export async function stageWorldBible(
  bookRecords: { id: number; title: string; author: string; synopsis: string | null; mood: string | null; setting: string | null; subgenre: string | null }[]
): Promise<void> {
  await Promise.allSettled(
    bookRecords.map(async (book) => {
      const userMsg = `Title: ${book.title}\nAuthor: ${book.author}\nSynopsis: ${book.synopsis ?? "No synopsis available."}\nMood: ${book.mood ?? "unknown"}\nSetting: ${book.setting ?? "unknown"}\nSubgenre: ${book.subgenre ?? "unknown"}`;
      try {
        const result = await withTimeout(
          invokeLLM({
            messages: [
              { role: "system", content: WORLD_BIBLE_SYSTEM },
              { role: "user", content: userMsg },
            ],
            response_format: { type: "json_object" },
          }),
          30_000,
          `WorldBible "${book.title}"`
        );
        const content = typeof result.choices[0]?.message?.content === "string"
          ? result.choices[0].message.content
          : "";
        const parsed = JSON.parse(content);
        await updateBookExtraction(book.id, {
          worldBible: {
            illustratorStyle: parsed.illustrator_style ?? "",
            keyVisualEnvironments: parsed.key_visual_environments ?? [],
            keyObjects: parsed.key_objects ?? [],
            lightingSignature: parsed.lighting_signature ?? "",
            textureLanguage: parsed.texture_language ?? "",
            typographyNative: parsed.typography_native ?? "",
            emotionalTone: parsed.emotional_tone ?? "",
            colorAnchors: parsed.color_anchors ?? [],
          },
        });
      } catch (err) {
        console.warn(`[Pipeline] WorldBible extraction failed for "${book.title}":`, err);
      }
    })
  );
}

// ─── Stage 3: Book Niche Research ────────────────────────────────────────

const NICHE_RESEARCH_SYSTEM = `You are a cultural research analyst specializing in book fandoms and print-on-demand merchandise markets. For a given book, you must research its fan community as a NICHE — treating the book's readership as a distinct audience with their own language, preferences, and gaps.

Given a book's title, author, subgenre, mood, and fan culture summary, answer THREE research questions. Return a single JSON object with three keys. Do NOT include any text outside the JSON.

REQUIRED OUTPUT SCHEMA:
{
  "fan_conversations": {
    "inside_jokes": ["string — 3-5 specific jokes, memes, or humorous references fans of this book share"],
    "slogans_catchphrases": ["string — 3-5 phrases or slogans fans use to identify with this book"],
    "community_references": ["string — 3-5 specific scenes, character traits, or running gags fans bond over"],
    "pain_points_they_joke_about": ["string — 2-3 relatable struggles fans laugh about"],
    "identity_markers": ["string — 3-5 things fans proudly display about themselves related to this book"]
  },
  "design_styles": {
    "color_palettes": ["string — 2-3 color palette descriptions that resonate with this audience"],
    "typography_preferences": ["string — 2-3 font/typography styles this audience gravitates toward"],
    "art_styles": ["string — 3-4 visual art styles that match this fandom's aesthetic"],
    "format_preferences": ["string — 3-4 merch formats this audience buys most"],
    "aesthetic_movements": ["string — 2-3 broader aesthetic movements this fandom aligns with"]
  },
  "white_space": {
    "untapped_humor_angles": ["string — 2-3 humor approaches no one has tried for this book's merch"],
    "ignored_sub_audiences": ["string — 2-3 audience segments being overlooked"],
    "missing_formats": ["string — 2-3 merch formats no one is making for this fandom"],
    "cross_fandom_opportunities": ["string — 2-3 other fandoms or cultural references that could be combined"],
    "oversaturated_vs_fresh": ["string — 2-3 observations about what's been done to death vs. what's wide open"]
  }
}

RULES:
1. Be SPECIFIC to this book and its actual fan community. No generic answers.
2. Inside jokes should feel like something you'd see in a Facebook group or Reddit thread for this book.
3. White space opportunities should be actionable — a designer should be able to act on them immediately.
4. Think about what fans would ACTUALLY wear or display, not what a publisher would make.
5. Return ONLY the JSON object. No markdown, no explanation.`;

async function stageNicheResearch(
  runId: number,
  bookRecords: {
    id: number;
    title: string;
    author: string;
    subgenre: string | null;
    mood: string | null;
    fanCulture: string | null;
  }[]
): Promise<void> {
  // Parallel niche research — all books at once instead of sequential
  await Promise.allSettled(
    bookRecords.map(async (book) => {
      const userMsg = `Book: "${book.title}" by ${book.author}
Subgenre: ${book.subgenre ?? "unknown"}
Mood: ${book.mood ?? "unknown"}
Fan Culture: ${book.fanCulture ?? "No fan culture data available."}`;

      try {
        const result = await withTimeout(
          invokeLLM({
            messages: [
              { role: "system", content: NICHE_RESEARCH_SYSTEM },
              { role: "user", content: userMsg },
            ],
            response_format: { type: "json_object" },
          }),
          30_000,
          `Niche research "${book.title}"`
        );

        const content = typeof result.choices[0]?.message?.content === "string"
          ? result.choices[0].message.content
          : "";
        const parsed = JSON.parse(content);

        await insertNicheResearch({
          runId,
          bookId: book.id,
          fanConversations: parsed.fan_conversations ?? null,
          designStyles: parsed.design_styles ?? null,
          whiteSpace: parsed.white_space ?? null,
        });
      } catch (err) {
        console.warn(`[Pipeline] Niche research failed for "${book.title}":`, err);
      }
    })
  );
}

// ─── Stage 4: Generate 5 Concepts (Niche-Informed) ──────────────────────

const GENERATION_SYSTEM = `You are a creative director for a print-on-demand merchandise company. Your job is to generate 5 original, copyright-safe design concepts for a book's fan community.

HARD CONSTRAINTS — COPYRIGHT SAFETY:
1. NEVER reference the book's title, author name, character names, or any trademarked phrase.
2. NEVER reproduce cover art, logos, or publisher imagery.
3. Designs must be INSPIRED BY the aesthetic and fan culture, NOT copies of the source material.
4. All concepts must be original enough to sell on Etsy, Redbubble, or Amazon Merch without a takedown.

═══ STEP 1: EXTRACT THE MOST-USED FAN PHRASES ═══
Before generating any concept, study the fan conversations and forum signals provided. Identify the 8-12 phrases, expressions, inside jokes, or identity markers that fans ACTUALLY USE the most — things they say to each other, quote, put in bios, or use as identity signals. These must be real phrases from the fan community, not invented combinations.

Rank them by frequency/cultural weight. The most-used phrase gets concept slot #1.

═══ STEP 2: ANCHOR EACH CONCEPT TO A REAL PHRASE ═══
Every concept MUST be anchored to one of those real fan phrases. The phrase becomes the headline (or the core idea behind the headline). Do NOT invent new phrases — start from what fans already say.

═══ STEP 3: STYLE FROM THE BOOK'S VISUAL UNIVERSE ═══
The style, colors, typography, and visual motifs MUST come from the book's actual aesthetic universe — the dominant colors, visual motifs, and art style provided in the book profile. Do NOT apply generic design trends. The design should feel like it belongs to this specific book's world.

Return a JSON object with a "concepts" array of exactly 5 objects. Do NOT include any text outside the JSON.

REQUIRED OUTPUT SCHEMA:
{
  "concepts": [
    {
      "concept_name": "string — short, evocative name (2-4 words)",
      "source_phrase": "string — the exact real fan phrase/quote this concept is anchored to",
      "humor_framework": "string — one of: cultural-insider, style-forward, white-space, anti-joke, cross-reference (let the phrase dictate this, do not force it)",
      "format": "string — one of: t-shirt, hoodie, tote bag, sticker, bookmark, mug, sweatshirt, enamel pin, phone case, poster",
      "style": "string — derived from the book's visual universe (e.g. dark academia, gothic, retro, distressed — must match the book's actual aesthetic)",
      "headline": "string — the main text on the design. Must be the source_phrase itself or a direct, minimal adaptation of it. NOT the book title.",
      "subtext": "string — optional secondary text that adds context or humor",
      "color_palette": ["string — 3-4 hex codes derived from the book's dominant color palette"],
      "layout_description": "string — 2-3 sentences describing the visual layout. Must reference the book's visual motifs and art style.",
      "font_suggestion": "string — font style that matches the book's typography aesthetic",
      "signal_tags": ["string — confirmed cross-source signals this concept uses (empty array if none)"],
      "copyright_safe": true
    }
  ]
}

RULES:
1. Each concept MUST be anchored to a DIFFERENT real fan phrase.
2. Each concept MUST use a DIFFERENT format.
3. Color palettes MUST be derived from the book's actual dominant colors — not generic.
4. Style MUST match the book's visual universe — not a generic trend.
5. The headline MUST be the source_phrase or a direct adaptation — never an invented phrase.
6. Return ONLY the JSON object.`;

async function stageGenerate(
  bookRecords: {
    id: number;
    runId: number;
    title: string;
    subgenre: string | null;
    mood: string | null;
    setting: string | null;
    dominantColors: string[] | null;
    visualMotifs: string[] | null;
    typographyStyle: string | null;
    fanCulture: string | null;
  }[],
  nicheResearchMap: Map<number, { fanConversations: any; designStyles: any; whiteSpace: any }>,
  forumSignalsMap?: Map<number, ForumSignals>
): Promise<void> {
  // Parallel concept generation — all books at once instead of sequential
  await Promise.allSettled(
    bookRecords.map(async (book) => {
    const niche = nicheResearchMap.get(book.id);

    // Extract cross-source signals if forum data is available
    const forumSignals = forumSignalsMap?.get(book.id);
    const crossSignals: CrossSourceSignal[] = forumSignals ? extractCrossSourceSignals(forumSignals) : [];
    const strongSignals = crossSignals.filter(s => s.sourceCount >= 2).slice(0, 8);
    const signalBlock = strongSignals.length > 0
      ? `\nCONFIRMED CROSS-SOURCE SIGNALS (themes found in multiple fan forums — HIGHEST PRIORITY):\n${strongSignals.map(s => `- "${s.theme}" confirmed by ${s.sourceCount} sources: ${s.sources.join(", ")}`).join("\n")}\n\nINSTRUCTION: At least 2 of your 5 concepts MUST be anchored to a confirmed cross-source signal above. Include the signal theme in the concept's headline, subtext, or layout_description. Add a "signal_tags" field (array of strings) to each concept listing which confirmed signals it uses (empty array if none).`
      : "\nNo cross-source forum signals available yet — rely on niche research only.";

    const userMsg = `Book aesthetic profile:
Subgenre: ${book.subgenre ?? "unknown"}
Mood: ${book.mood ?? "unknown"}
Setting: ${book.setting ?? "unknown"}
Color Palette: ${(book.dominantColors ?? []).join(", ") || "not specified"}
Visual Motifs: ${(book.visualMotifs ?? []).join(", ") || "not specified"}
Typography: ${book.typographyStyle ?? "not specified"}
Fan Culture: ${book.fanCulture ?? "not specified"}
${signalBlock}

NICHE RESEARCH:
Fan Conversations: ${niche ? JSON.stringify(niche.fanConversations) : "No research available"}
Design Styles: ${niche ? JSON.stringify(niche.designStyles) : "No research available"}
White Space Opportunities: ${niche ? JSON.stringify(niche.whiteSpace) : "No research available"}`;

    try {
      const result = await withTimeout(
        invokeLLM({
          messages: [
            { role: "system", content: GENERATION_SYSTEM },
            { role: "user", content: userMsg },
          ],
          response_format: { type: "json_object" },
        }),
        45_000,
        `Generate concepts for "${book.title}"`
      );

      const content = typeof result.choices[0]?.message?.content === "string"
        ? result.choices[0].message.content
        : "";

      let parsed = JSON.parse(content);
      let conceptsArray = parsed.concepts ?? parsed;
      if (!Array.isArray(conceptsArray)) {
        const keys = Object.keys(parsed);
        for (const key of keys) {
          if (Array.isArray(parsed[key])) {
            conceptsArray = parsed[key];
            break;
          }
        }
      }
      if (!Array.isArray(conceptsArray)) {
        console.warn(`[Pipeline] Generation for "${book.title}" did not return an array`);
        return;
      }

      // Find the niche research ID for linking
      const nicheResearchRecords = await getNicheResearchByRunId(book.runId);
      const nicheRecord = nicheResearchRecords.find(nr => nr.bookId === book.id);

      for (const c of conceptsArray.slice(0, 5)) {
        await insertConcept({
          bookId: book.id,
          runId: book.runId,
          conceptName: c.concept_name ?? "Untitled Concept",
          format: c.format ?? "t-shirt",
          style: c.style ?? "minimal",
          headline: c.headline ?? null,
          subtext: c.subtext ?? null,
          colorPalette: c.color_palette ?? null,
          layoutDescription: c.layout_description ?? null,
          fontSuggestion: c.font_suggestion ?? null,
          copyrightSafe: c.copyright_safe !== false,
          humorFramework: c.humor_framework ?? null,
          nicheResearchId: nicheRecord?.id ?? null,
          signalTags: Array.isArray(c.signal_tags) ? c.signal_tags : [],
          sourcePhrase: c.source_phrase ?? null,
        });
      }
    } catch (err) {
      console.warn(`[Pipeline] Generation failed for "${book.title}":`, err);
    }
    })
  );
}

// ─── Stage 5: Score + Etsy Validation ───────────────────────────────────

const SCORING_SYSTEM = `You are a trend analyst for a print-on-demand merchandise company. Score design concepts for their market potential using niche research evidence.

You will receive a list of design concepts along with their associated niche research data. Score each concept on 3 dimensions. Return a JSON object with a "scores" array, one entry per concept, in the SAME ORDER as the input.

SCORING DIMENSIONS (each scored 0-100):

1. social_momentum (0-100): How strongly does this concept connect to active fan conversations? Does it reference real inside jokes, slogans, or identity markers?
2. design_novelty (0-100): How different is this from existing merch? Does it exploit a white space opportunity? Or is it oversaturated?
3. audience_size (0-100): How large and engaged is the target audience for this specific concept?

REQUIRED OUTPUT SCHEMA:
{
  "scores": [
    {
      "concept_id": "number — the concept ID from input",
      "social_momentum": { "score": 75, "rationale": "string — 1 sentence" },
      "design_novelty": { "score": 80, "rationale": "string — 1 sentence" },
      "audience_size": { "score": 70, "rationale": "string — 1 sentence" },
      "total_score": 225
    }
  ]
}

RULES:
1. total_score = social_momentum.score + design_novelty.score + audience_size.score
2. Scores must be integers between 0 and 100 inclusive.
3. Rationales must reference SPECIFIC evidence from the niche research.
4. Anti-joke concepts should score higher on social_momentum if the humor connects to real fan pain points.
5. White-space concepts should score higher on design_novelty.
6. Be CRITICAL and DISCRIMINATING. Use the FULL range of scores (20-95). Not every concept deserves 70+. At least 30% of concepts should score below 180 total.
7. Return ONLY the JSON object.`;

async function stageScoreAndValidate(
  runId: number,
  etsyApiKey: string | undefined
): Promise<void> {
  const concepts = await getConceptsByRunId(runId);
  const nicheResearchRecords = await getNicheResearchByRunId(runId);
  const bookRecords = await getBooksByRunId(runId);

  if (concepts.length === 0) return;

  // Build niche research map by bookId
  const nicheMap = new Map<number, any>();
  for (const nr of nicheResearchRecords) {
    nicheMap.set(nr.bookId, {
      fanConversations: nr.fanConversations,
      designStyles: nr.designStyles,
      whiteSpace: nr.whiteSpace,
    });
  }

  // Prepare scoring input — batch by book for context
  const scoringInput = concepts.map((c) => ({
    concept_id: c.id,
    concept_name: c.conceptName,
    humor_framework: c.humorFramework,
    format: c.format,
    style: c.style,
    headline: c.headline,
    niche_research: nicheMap.get(c.bookId) ?? null,
  }));

  // LLM scoring — with timeout
  try {
    const result = await withTimeout(
      invokeLLM({
        messages: [
          { role: "system", content: SCORING_SYSTEM },
          { role: "user", content: JSON.stringify(scoringInput) },
        ],
        response_format: { type: "json_object" },
      }),
      120_000, // 120s — Gemini 2.5 Flash with 30 concepts can take 25-90s under load
      "Scoring all concepts"
    );

    const content = typeof result.choices[0]?.message?.content === "string"
      ? result.choices[0].message.content
      : "";

    let parsed = JSON.parse(content);
    let scoresArray = parsed.scores ?? parsed;
    if (!Array.isArray(scoresArray)) {
      const keys = Object.keys(parsed);
      for (const key of keys) {
        if (Array.isArray(parsed[key])) {
          scoresArray = parsed[key];
          break;
        }
      }
    }

    if (Array.isArray(scoresArray)) {
      console.log(`[Pipeline/Stage5] Scoring LLM returned ${scoresArray.length} scores`);
      for (const score of scoresArray) {
        const conceptId = score.concept_id;
        const total = score.total_score ??
          ((score.social_momentum?.score ?? 0) +
           (score.design_novelty?.score ?? 0) +
           (score.audience_size?.score ?? 0));

        await updateConceptScore(conceptId, total);
      }

      // Also update book-level scores from the best concept per book
      const bookBestScores = new Map<number, number>();
      for (const score of scoresArray) {
        const concept = concepts.find(c => c.id === score.concept_id);
        if (!concept) continue;
        const total = score.total_score ??
          ((score.social_momentum?.score ?? 0) +
           (score.design_novelty?.score ?? 0) +
           (score.audience_size?.score ?? 0));
        const current = bookBestScores.get(concept.bookId) ?? 0;
        if (total > current) bookBestScores.set(concept.bookId, total);

        // Update book scores with the first matching score data
        const sm = score.social_momentum;
        const dn = score.design_novelty;
        const as_ = score.audience_size;
        await updateBookScores(concept.bookId, {
          trendScoreTotal: total,
          socialMomentum: sm?.score ?? 0,
          socialRationale: sm?.rationale ?? "",
          designNovelty: dn?.score ?? 0,
          designRationale: dn?.rationale ?? "",
          audienceSize: as_?.score ?? 0,
          audienceRationale: as_?.rationale ?? "",
        });
      }
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[Pipeline/Stage5] Scoring FAILED — all ${concepts.length} concepts will have NULL trendScore and NO images will be generated. Error: ${errMsg}`);
    // Re-throw so withSelfHeal can retry
    throw err;
  }

  // Etsy validation — runs for each concept with keywords
  if (etsyApiKey) {
    await runEtsyValidation(concepts, etsyApiKey);
  } else {
    console.log("[Pipeline] Etsy API key not configured — skipping market validation");
  }
}

async function runEtsyValidation(
  concepts: { id: number; headline: string | null; format: string; style: string }[],
  etsyApiKey: string
): Promise<void> {
  for (const concept of concepts) {
    try {
      // Build search keywords from the concept
      const keywords = [concept.format, concept.headline ?? concept.style]
        .filter(Boolean)
        .join(" ")
        .slice(0, 100);

      const url = `https://openapi.etsy.com/v3/application/listings/active?keywords=${encodeURIComponent(keywords)}&limit=25&sort_on=score`;
      const resp = await fetch(url, {
        headers: { "x-api-key": etsyApiKey },
        signal: AbortSignal.timeout(10000),
      });

      if (!resp.ok) {
        // Graceful skip — key may be pending approval
        if (resp.status === 401 || resp.status === 403) {
          console.log("[Pipeline] Etsy API key not yet active — skipping validation");
          return; // Stop all Etsy calls if key is invalid
        }
        continue;
      }

      const data = await resp.json();
      const results = data.results ?? [];
      const count = data.count ?? results.length;

      if (results.length > 0) {
        const prices = results
          .map((r: any) => parseFloat(r.price?.amount ?? 0) / (r.price?.divisor ?? 100))
          .filter((p: number) => p > 0);

        const avgPrice = prices.length > 0
          ? prices.reduce((a: number, b: number) => a + b, 0) / prices.length
          : null;
        const minPrice = prices.length > 0 ? Math.min(...prices) : null;
        const maxPrice = prices.length > 0 ? Math.max(...prices) : null;
        const topFavorites = Math.max(...results.map((r: any) => r.num_favorers ?? 0));

        // Determine saturation level
        let saturationLevel: "low" | "medium" | "high" = "low";
        if (count > 10000) saturationLevel = "high";
        else if (count > 1000) saturationLevel = "medium";

        await insertMarketValidation({
          conceptId: concept.id,
          etsyListingCount: count,
          avgPrice: avgPrice ? String(avgPrice) : null,
          minPrice: minPrice ? String(minPrice) : null,
          maxPrice: maxPrice ? String(maxPrice) : null,
          topFavorites,
          saturationLevel,
          searchKeywords: keywords,
        });
      } else {
        await insertMarketValidation({
          conceptId: concept.id,
          etsyListingCount: 0,
          saturationLevel: "low",
          searchKeywords: keywords,
        });
      }

      // Rate limit Etsy API calls (5 QPS limit)
      await new Promise((r) => setTimeout(r, 250));
    } catch (err) {
      console.warn(`[Pipeline] Etsy validation failed for concept ${concept.id}:`, err);
    }
  }
}

// ─── Stage 6: Design Expansion + Image Generation ───────────────────────
// Global top-5 winners get 3 image variations each:
//   Variation A: Clean/Bold — fully IP-accurate, light distress, hero version
//   Variation B: Distressed/Aged — same concept, heavy IP-accurate damage language
//   Variation C: Alternative Composition — same phrase, different layout angle

/**
 * Builds a style-aware image prompt system from computed StyleProfile directives.
 * Replaces the generic World Bible references with market-derived aesthetic constraints.
 * The 10-layer DTF formula structure is preserved; only the style inputs change.
 */
function buildStyleAwarePromptSystem(s: import("../shared/styleProfile").StyleProfile): string {
  return `You are a senior art director and DTF print specialist. Your job is to write THREE deeply detailed image generation prompts for a t-shirt graphic design. Each prompt must be built using the exact 10-layer formula below, in order. Minimum 400 words per prompt. Return ONLY a JSON object — no markdown, no explanation.

You are writing a design that will ACTUALLY SELL on Etsy and print-on-demand platforms. Every design decision must be grounded in what top sellers in this market look like, not generic design theory.

MARKET REFERENCE: ${s.marketReference}
PRIMARY AESTHETIC: ${s.primaryAesthetic}
AVOID AT ALL COSTS: ${s.avoidDirectives.join(", ")}

═══ DTF SILHOUETTE RULE — NON-NEGOTIABLE ═══

These designs are printed via DTF (Direct to Film). Every pixel of the generated image becomes physical ink transferred onto fabric. There is NO masking, NO transparency — whatever the AI generates, the printer transfers.

❌ WHAT KILLS A DTF DESIGN (NEVER DO THESE):
- A solid dark background fill — transfers as a stiff plastic rectangle on the shirt
- Atmospheric gradients filling space between elements
- Scene-style illustrations where a background environment fills the entire canvas
- Any area filled with color purely to create atmosphere rather than define a graphic element
- Any composition that would look like a rectangle if printed on a sticker sheet
- Cartoonish clip-art style — bright saturated colors, digital vector smoothness, no texture
- More than ${s.maxColors} ink colors — this market uses ${s.maxColors} colors maximum

✅ WHAT A DTF DESIGN MUST LOOK LIKE:
Think of the design as a sticker with holes punched through it. The outer silhouette is organic — a badge shape, an emblem, an arch, scattered type elements — NEVER a rectangle or square. Inside the design there are genuine open areas where the white canvas (shirt fabric) shows through. Every element — text, illustration, border, detail — is a discrete graphic object with its own defined edge, floating in white space rather than swimming in a filled background.

The shirt color itself becomes part of the design. Complexity lives IN the elements. The shirt breathes BETWEEN them.

═══ THE 10-LAYER FORMULA ═══

[1] PRINT FORMAT DECLARATION
Always open with: "Ultra-detailed ${s.maxColors}-color t-shirt graphic design for DTF transfer printing, isolated graphic with open negative space throughout,"
Never skip this. The phrases "DTF transfer printing" and "open negative space" must both appear in the opening line.

[2] STYLE ANCHOR
Primary aesthetic: ${s.primaryAesthetic}. Texture level: ${s.textureLevel}. This is NOT a digital vector illustration — it is a ${s.primaryAesthetic} design with ${s.textureLevel} texture. Describe the aesthetic in visual terms: line weight, texture density, compositional habits, print medium feel. Pattern: "${s.primaryAesthetic} aesthetic — [3-5 specific visual style descriptors matching this aesthetic], ${s.textureLevel} texture, [contrast approach appropriate to this style]"

[3] CONCEPT CORE
Describe the central visual element in maximum detail. Include: what the object/scene IS, its physical material and condition, what makes it specific to THIS niche/phrase. Must include at least 4 niche-accurate visual details.

⚠️ IMMEDIATELY AFTER THE CONCEPT CORE, insert all four of these DTF silhouette enforcement statements word-for-word:
1. "the design sits on a pure white background with genuine open negative space throughout — the white background is visible between all elements and inside the letterforms, never filled"
2. "no background fill of any kind — no dark atmospheric background, no environment fill, no gradient wash, no vignette — only the graphic elements themselves carry ink"
3. "the outer silhouette of the entire design is [CHOOSE ONE: badge/emblem | typographic stack | arch/banner | crest/coat of arms | scattered sponsor layout | icon + type lockup | vintage label] — not a rectangle, not a square, not a full bleed scene"
4. "designed for DTF direct-to-film transfer printing — all negative space must be genuinely white/transparent so the shirt fabric shows through between and inside all design elements"

[4] TYPOGRAPHY TREATMENT
Typography style for this market: ${s.typographyStyle}. Be extremely specific: font personality matching ${s.typographyStyle}, physical texture of the letters (carved / spray-painted / hand-lettered / embossed), how text interacts with the design, layout behavior (arched / stacked / wrapped). Pattern: "[phrase] rendered in [font style matching ${s.typographyStyle}] with [physical material treatment], [how it interacts with surrounding elements], [placement in composition]"

[5] NICHE-ACCURATE DETAILS
Pull 3-6 specific micro-details that are authentic to this niche/community. These are the insider details that make a fan stop and say "they actually get it." Weave them into the composition as supporting elements: community objects, symbols, in-jokes, thematic references. CRITICAL: these details are discrete graphic objects floating in white space — they do NOT form a background scene.

[6] LIGHTING + ATMOSPHERE
Every design must have a defined light source appropriate to the ${s.primaryAesthetic} aesthetic. The light illuminates the graphic elements — it does NOT create a filled background environment. Write as: "lighting: [primary source] casting [color] [direction] on [what surfaces], secondary fill light from [secondary source] in [color], deep shadow in [areas], rim light highlighting [specific edges] — all light falls on graphic elements only, no background fill"

[7] DISTRESS LAYER — constrained to ${s.textureLevel}
Variation A (Clean/Bold): ${s.textureLevel === "heavy-vintage" || s.textureLevel === "moderate-worn" ? "Moderate distress — halftone grain, ink bleed, subtle wear at edges appropriate to " + s.primaryAesthetic : "Light distress only — subtle grain, minor wear at edges"}.
Variation B (Distressed/Aged): Maximum distress appropriate to ${s.primaryAesthetic} — pull from: weathered and crumbling at the edges | screen-printed ink bleed on old fabric | halftone grain oxidation | faded vintage wash with color drop-out | sun-bleached ink fade | peeling paint revealing undercoat | letterpress ink squash on rough paper stock | age-yellowed paper with foxing spots | rust bleed from embedded metal
Variation C (Alternative Composition): Moderate or stylistic distress only if it serves the alternate compositional angle.

[8] COMPOSITION + LAYOUT — preferred: ${s.compositionPreferences.join(" or ")}
Specify exactly how visual elements are arranged. Choose from the preferred compositions for this market: ${s.compositionPreferences.join(" | ")}. Add proportion guidance, axis alignment, breathing room vs. intentional density.

[9] COLOR DECLARATION — HARD LIMIT: ${s.maxColors} colors maximum
Color directive for this market: ${s.colorDirective}. Declare: primary color (50%+ of design), secondary color (30%), accent color (10-15%), highlight (5% — sparks, fine lines). Use muted, market-accurate color names. Example format: "color palette: primary [muted name] ([hex]), secondary [muted name] ([hex]), accent [muted name] ([hex]), highlight [muted name] ([hex]), designing for [shirt color] — all colors specified as ink on [dark/light] garment — MAXIMUM ${s.maxColors} COLORS TOTAL"

[10] PRINT SAFETY CLOSE
Every prompt MUST end with this exact block word-for-word:
"— isolated on pure white background, genuine open negative space throughout the entire design including between all elements and inside all letterforms, no background fill of any kind, no atmospheric fill, no dark environment backdrop, no gradient wash, outer silhouette is an organic graphic shape not a rectangle, designed for DTF direct-to-film transfer printing so the shirt fabric shows through all negative space, clean die-cut edges, print-ready artwork, high contrast graphic elements only, t-shirt graphic design"

═══ VARIATION DEFINITIONS ═══

VARIATION A — Clean/Bold:
- Full complexity, fully niche-accurate, all community details present
- ${s.textureLevel === "heavy-vintage" || s.textureLevel === "moderate-worn" ? "Moderate distress appropriate to " + s.primaryAesthetic : "Light distress only"}
- Maximum visual impact — this is the hero version
- Prompt length: 400-600 words

VARIATION B — Distressed/Aged:
- Same core concept and composition as Variation A
- Rebuilds the distress layer from scratch using heavy, specific damage language
- Changes: add 4-6 distress techniques, shift colors to more faded/muted versions, add material degradation details
- Prompt length: 400-600 words
- Opening modifier: "Battle-damaged and time-worn version of a [concept description], extreme distress applied throughout,"

VARIATION C — Alternative Composition:
- Same phrase, different design angle — pick a different composition from the preferred list
- Can shift to a different style lens within the ${s.primaryAesthetic} aesthetic
- Prompt length: 400-600 words
- Opening modifier: "Alternative composition for [concept], [new compositional angle],"

═══ HARD CONSTRAINTS ═══
1. ZERO trademarked character names anywhere in any prompt.
2. ZERO references to copyrighted artwork or specific IP illustrations.
3. Each prompt must be between 400-600 words — if under 300, it is too vague; rebuild it.
4. The source fan phrase must appear as readable text in the design.
5. All designs must be isolated on pure white background — the shirt IS the background.
6. ZERO language describing a filled background environment. Describe elements AS objects floating in white space.
7. Every prompt must name the outer silhouette shape. If you cannot name the shape, the design is a rectangle — rebuild it.
8. All four DTF silhouette enforcement statements must appear immediately after the Concept Core [3].
9. MAXIMUM ${s.maxColors} COLORS — this is a hard limit, not a suggestion.
10. AVOID: ${s.avoidDirectives.join(", ")} — these are anti-patterns for this specific market.

REQUIRED OUTPUT SCHEMA — return ONLY this JSON object:
{
  "variation_a": "string — full 400-600 word prompt for Clean/Bold variation",
  "variation_b": "string — full 400-600 word prompt for Distressed/Aged variation",
  "variation_c": "string — full 400-600 word prompt for Alternative Composition variation"
}`;
}

const IMAGE_PROMPT_SYSTEM = `You are a senior art director and DTF print specialist. Your job is to write THREE deeply detailed image generation prompts for a t-shirt graphic design. Each prompt must be built using the exact 10-layer formula below, in order. Minimum 400 words per prompt. Return ONLY a JSON object — no markdown, no explanation.

You are writing a love letter to a specific fictional world expressed through the language of garment printing. Every prompt must make a fan think: "Whoever made this actually read the book."

═══ DTF SILHOUETTE RULE — NON-NEGOTIABLE ═══

These designs are printed via DTF (Direct to Film). Every pixel of the generated image becomes physical ink transferred onto fabric. There is NO masking, NO transparency — whatever the AI generates, the printer transfers.

❌ WHAT KILLS A DTF DESIGN (NEVER DO THESE):
- A solid dark background fill — transfers as a stiff plastic rectangle on the shirt
- Atmospheric gradients filling space between elements
- Scene-style illustrations where a background environment (dungeon walls, dark sky, stone floor) fills the entire canvas
- Any area filled with color purely to create atmosphere rather than define a graphic element
- Any composition that would look like a rectangle if printed on a sticker sheet

✅ WHAT A DTF DESIGN MUST LOOK LIKE:
Think of the design as a sticker with holes punched through it. The outer silhouette is organic — a badge shape, an emblem, an arch, scattered type elements — NEVER a rectangle or square. Inside the design there are genuine open areas where the white canvas (shirt fabric) shows through. Every element — text, illustration, border, detail — is a discrete graphic object with its own defined edge, floating in white space rather than swimming in a filled background.

The shirt color itself becomes part of the design. Complexity lives IN the elements. The shirt breathes BETWEEN them.

═══ THE 10-LAYER FORMULA ═══

[1] PRINT FORMAT DECLARATION
Always open with: "Ultra-detailed [N]-color t-shirt graphic design for DTF transfer printing, isolated graphic with open negative space throughout,"
Never skip this. The phrases "DTF transfer printing" and "open negative space" must both appear in the opening line — they are the primary signals that prevent solid background blocks.

[2] STYLE ANCHOR
Pull the illustrator style from the World Bible. Describe their aesthetic in visual terms — lighting approach, line weight, texture density, compositional habits. Pattern: "[IP title] cover art aesthetic — [illustrator name if known] style: [3-5 specific visual style descriptors pulled from research], [genre visual mood], [contrast approach]"

[3] CONCEPT CORE
Describe the central visual element in maximum detail. Include: what the object/scene IS, its physical material and condition, its exact relationship to the IP world, what makes it specific to THIS book. Must include at least 4 IP-accurate visual details from the World Bible.

⚠️ IMMEDIATELY AFTER THE CONCEPT CORE, insert all four of these DTF silhouette enforcement statements word-for-word:
1. "the design sits on a pure white background with genuine open negative space throughout — the white background is visible between all elements and inside the letterforms, never filled"
2. "no background fill of any kind — no dark atmospheric background, no dungeon environment fill, no gradient wash, no vignette — only the graphic elements themselves carry ink"
3. "the outer silhouette of the entire design is [CHOOSE ONE: badge/emblem | typographic stack | arch/banner | crest/coat of arms | scattered sponsor layout | icon + type lockup | vintage label] — not a rectangle, not a square, not a full bleed scene"
4. "designed for DTF direct-to-film transfer printing — all negative space must be genuinely white/transparent so the shirt fabric shows through between and inside all design elements"

[4] TYPOGRAPHY TREATMENT
Be extremely specific: font personality (blackletter gothic / heavy slab condensed / pixelated monospace / hand-painted stencil), physical texture of the letters (carved in stone / spray-painted / LED pixel / embossed metal), how text interacts with environment (casting shadows / glowing / cracking / bleeding ink), layout behavior (arched / stacked / wrapped around image / bleeding off edge). Pattern: "[phrase] rendered in [font style] with [physical material treatment] showing [specific damage or texture], [how it interacts with surrounding elements], [placement in composition]"

[5] WORLD-ACCURATE DETAILS
Pull 3-6 specific micro-details from the World Bible key objects, key environments, and texture language. These are the insider details that make a fan stop and say "they actually read the book." Weave them into the composition as supporting elements: environmental textures, object details, thematic symbols, in-world text fragments. CRITICAL: these details are discrete graphic objects floating in white space — they do NOT form a background scene or environment fill.

[6] LIGHTING + ATMOSPHERE
Every design must have a defined light source from the IP world. The light illuminates the graphic elements — it does NOT create a filled background environment. Write as: "lighting: [primary source] casting [color] [direction] on [what surfaces], secondary fill light from [secondary source] in [color], deep shadow in [areas], rim light highlighting [specific edges] — all light falls on graphic elements only, no background fill"

[7] DISTRESS LAYER
Variation A (Clean/Bold): Light distress only — subtle halftone grain, minor ink bleed, slight wear at edges.
Variation B (Distressed/Aged): Maximum distress — pull from this vocabulary: weathered and crumbling at the edges | battle-scarred surface | acid-etched metal | spray-painted stencil with paint drips | screen-printed ink bleed on old fabric | halftone grain oxidation | faded vintage wash with color drop-out | oxidized and verdigris-covered metal | torn paper revealing layer beneath | corrupted pixel bleed escaping containment | heavy CRT scanline artifacts | impact cracks radiating from a stress point | water stain tide marks | sun-bleached ink fade | peeling paint revealing undercoat | fire-scorched edges | rust bleed from embedded metal fixtures | letterpress ink squash on rough paper stock | rubber tire smear overlay | oil stain contamination | age-yellowed paper stock with foxing spots
Variation C (Alternative Composition): Moderate or stylistic distress only if it serves the alternate compositional angle.

[8] COMPOSITION + LAYOUT
Specify exactly how visual elements are arranged. Use clock positions, spatial relationships, proportion language. Choose from: Full chest monument (primary text 80%+ of chest width, no central illustration — pure typographic power) | Badge/emblem (circular or oval badge, illustration centered, text wrapping perimeter, layered borders) | Vertical stack (illustration top 40%, text fills bottom 60%) | Horizontal banner (text arched above/below central panoramic illustration) | Scattered sponsor layout (multiple text elements and icons distributed across full chest — large open shirt areas between each element) | Small chest logo (tight 3-4 inch left chest, all elements must read clearly at small scale) | Full bleed poster (elements arranged like a movie or concert poster). Add proportion guidance, axis alignment, breathing room vs. intentional density.

[9] COLOR DECLARATION
Declare: primary color (50%+ of design), secondary color (30%), accent color (10-15%), highlight (5% — sparks, glows, fine lines), shirt color context. Use IP-accurate color names from the World Bible color anchors, not generic names. Example format: "color palette: primary [IP-accurate name] ([hex]), secondary [IP-accurate name] ([hex]), accent [IP-accurate name] ([hex]), highlight [IP-accurate name] ([hex]), designing for [shirt color] — all colors specified as ink on [dark/light] garment"

[10] PRINT SAFETY CLOSE
Every prompt MUST end with this exact block word-for-word:
"— isolated on pure white background, genuine open negative space throughout the entire design including between all elements and inside all letterforms, no background fill of any kind, no atmospheric fill, no dark environment backdrop, no gradient wash, outer silhouette is an organic graphic shape not a rectangle, designed for DTF direct-to-film transfer printing so the shirt fabric shows through all negative space, clean die-cut edges, print-ready artwork, high contrast graphic elements only, t-shirt graphic design"

═══ VARIATION DEFINITIONS ═══

VARIATION A — Clean/Bold:
- Full complexity, fully IP-accurate, all world details present
- Light distress only (halftone grain, subtle ink bleed)
- Maximum visual impact — this is the hero version
- Prompt length: 400-600 words

VARIATION B — Distressed/Aged:
- Same core concept and composition as Variation A
- Rebuilds the distress layer from scratch using heavy, specific, IP-accurate damage language
- Changes: add 4-6 distress techniques, shift colors to more faded/muted versions, add material degradation details
- Prompt length: 400-600 words
- Opening modifier: "Battle-damaged and time-worn version of a [concept description], extreme distress applied throughout,"

VARIATION C — Alternative Composition:
- Same phrase, different design angle — pick a different composition template from [8]
- Can shift to a different art style lens (e.g., if A was painterly, C could be flat vector or pixel art)
- Must still be 100% IP-accurate to the World Bible
- Prompt length: 400-600 words
- Opening modifier: "Alternative composition for [concept], [new style lens],"

═══ HARD CONSTRAINTS ═══
1. ZERO trademarked character names anywhere in any prompt.
2. ZERO references to copyrighted book cover art or specific IP illustrations.
3. Each prompt must be between 400-600 words — if under 300, it is too vague; rebuild it.
4. The source fan phrase must appear as readable text in the design.
5. All designs must be isolated on pure white background — the shirt IS the background.
6. ZERO language describing a filled background environment (dungeon walls, dark sky, stone floor as backdrop). Describe elements AS objects floating in white space, not as a scene.
7. Every prompt must name the outer silhouette shape. If you cannot name the shape, the design is a rectangle — rebuild it.
8. All four DTF silhouette enforcement statements must appear immediately after the Concept Core [3].

REQUIRED OUTPUT SCHEMA — return ONLY this JSON object:
{
  "variation_a": "string — full 400-600 word prompt for Clean/Bold variation",
  "variation_b": "string — full 400-600 word prompt for Distressed/Aged variation",
  "variation_c": "string — full 400-600 word prompt for Alternative Composition variation"
}`;

async function stageDesignExpansion(runId: number): Promise<number> {
  const stageStart = Date.now();
  console.log(`[Pipeline/Stage6] START stageDesignExpansion for run ${runId}`);
  const concepts = await getConceptsByRunId(runId);
  console.log(`[Pipeline/Stage6] Fetched ${concepts.length} concepts from DB`);

  // ── Step 1: Rank ALL concepts globally by trendScore (descending) ────
  const ranked = [...concepts]
    .filter((c) => c.trendScore !== null && c.trendScore > 0)
    .sort((a, b) => (b.trendScore ?? 0) - (a.trendScore ?? 0));
  console.log(`[Pipeline/Stage6] ${ranked.length} concepts have trendScore > 0`);

  // Assign globalRank to every scored concept
  for (let i = 0; i < ranked.length; i++) {
    const isWinner = i < MAX_WINNER_CONCEPTS;
    await updateConceptImages(ranked[i].id, {
      globalRank: i + 1,
      isWinner,
    });
  }

  // ── Step 2: Select top 5 winners for image generation ────────────────
  // IMMUTABILITY GUARD: Only generate images for winners that don't already have them.
  // Concepts are permanent records — existing images must never be replaced.
  const allWinners = ranked.slice(0, MAX_WINNER_CONCEPTS);
  const winners = allWinners.filter((c) => !c.imageUrlA);

  if (allWinners.length === 0) {
    console.log(`[Pipeline/Stage6] No scored concepts — skipping image generation (elapsed: ${Date.now() - stageStart}ms)`);
    return 0;
  }

  console.log(`[Pipeline/Stage6] allWinners: ${allWinners.map(w => `${w.conceptName}(img=${!!w.imageUrlA})`).join(', ')}`);

  if (winners.length === 0) {
    console.log(`[Pipeline/Stage6] All ${allWinners.length} winner concepts already have images — skipping regeneration (elapsed: ${Date.now() - stageStart}ms)`);
    return 0;
  }

  if (winners.length < allWinners.length) {
    console.log(`[Pipeline] ${allWinners.length - winners.length} winner(s) already have images, generating for ${winners.length} remaining`);
  }

  const maxImages = winners.length * IMAGES_PER_WINNER;
  console.log(
    `[Pipeline] ${winners.length} global winners selected. Generating ${IMAGES_PER_WINNER} images each (${maxImages} images max)`
  );

  // Log which books the winners belong to
  const winnerBookIds = new Set(winners.map(w => w.bookId));
  console.log(`[Pipeline] Winners span ${winnerBookIds.size} book(s)`);

  // Fetch book records for visual universe data
  const winnerBookIdArray = Array.from(winnerBookIds).filter((id): id is number => id !== null);
  const bookRecordsForImages = await getBooksByIds(winnerBookIdArray);
  const bookMapForImages = new Map(bookRecordsForImages.map(b => [b.id, b]));

  // ── Step 3: Get 3 variation prompts per winner from LLM in parallel ──
  type PromptSet = { concept: typeof winners[0]; promptA: string; promptB: string; promptC: string };

  const promptTasks = winners.map(async (concept): Promise<PromptSet | null> => {
    const book = concept.bookId ? bookMapForImages.get(concept.bookId) : null;
    const wb = book?.worldBible as {
      illustratorStyle?: string;
      keyVisualEnvironments?: string[];
      keyObjects?: string[];
      lightingSignature?: string;
      textureLanguage?: string;
      typographyNative?: string;
      emotionalTone?: string;
      colorAnchors?: string[];
    } | null | undefined;

    // Style Intelligence: read computed directives from book row (set by Stage 5.5)
    const styleDirectives = book?.styleDirectives as import("../shared/styleProfile").StyleProfile | null | undefined;

    let activePromptSystem: string;
    let userMsg: string;

    if (styleDirectives) {
      // Style-aware path: use directives computed by Stage 5.5
      activePromptSystem = buildStyleAwarePromptSystem(styleDirectives);
      userMsg = `Design concept:
Name: ${concept.conceptName}
Source Fan Phrase: ${concept.sourcePhrase ?? "not specified"}
Humor Framework: ${concept.humorFramework ?? "general"}
Format: ${concept.format}
Style: ${concept.style}
Headline: ${concept.headline ?? "none"}
Subtext: ${concept.subtext ?? "none"}
Color Palette: ${(concept.colorPalette as string[] ?? []).join(", ") || "not specified"}
Layout: ${concept.layoutDescription ?? "not specified"}
Font: ${concept.fontSuggestion ?? "not specified"}

[STYLE_DIRECTIVES]
Primary Aesthetic: ${styleDirectives.primaryAesthetic}
Color Directive: ${styleDirectives.colorDirective}
Max Colors: ${styleDirectives.maxColors}
Texture Level: ${styleDirectives.textureLevel}
Composition Preferences: ${styleDirectives.compositionPreferences.join(", ")}
Typography Style: ${styleDirectives.typographyStyle}
Market Reference: ${styleDirectives.marketReference}
AVOID: ${styleDirectives.avoidDirectives.join(", ")}`;
    } else {
      // Legacy fallback: use original World Bible path
      activePromptSystem = IMAGE_PROMPT_SYSTEM;
      userMsg = `Design concept:
Name: ${concept.conceptName}
Source Fan Phrase: ${concept.sourcePhrase ?? "not specified"}
Humor Framework: ${concept.humorFramework ?? "general"}
Format: ${concept.format}
Style: ${concept.style}
Headline: ${concept.headline ?? "none"}
Subtext: ${concept.subtext ?? "none"}
Color Palette: ${(concept.colorPalette as string[] ?? []).join(", ") || "not specified"}
Layout: ${concept.layoutDescription ?? "not specified"}
Font: ${concept.fontSuggestion ?? "not specified"}

[BOOK_WORLD_BIBLE]
Illustrator Style: ${wb?.illustratorStyle ?? book?.typographyStyle ?? "not specified"}
Key Visual Environments: ${(wb?.keyVisualEnvironments ?? []).join("; ") || "not specified"}
Key Objects: ${(wb?.keyObjects ?? []).join("; ") || "not specified"}
Lighting Signature: ${wb?.lightingSignature ?? "not specified"}
Texture Language: ${wb?.textureLanguage ?? "not specified"}
Typography Native: ${wb?.typographyNative ?? book?.typographyStyle ?? "not specified"}
Emotional Tone: ${wb?.emotionalTone ?? book?.mood ?? "not specified"}
Color Anchors: ${(wb?.colorAnchors ?? book?.dominantColors ?? []).join(", ") || "not specified"}

Book Visual Universe (legacy fields):
Dominant Colors: ${(book?.dominantColors ?? []).join(", ") || "not specified"}
Visual Motifs: ${(book?.visualMotifs ?? []).join(", ") || "not specified"}
Typography Style: ${book?.typographyStyle ?? "not specified"}
Art Style / Mood: ${book?.mood ?? "not specified"}
Setting: ${book?.setting ?? "not specified"}
Subgenre: ${book?.subgenre ?? "not specified"}`;
    }

    try {
      const promptResult = await withTimeout(
        invokeLLM({
          messages: [
            { role: "system", content: activePromptSystem },
            { role: "user", content: userMsg },
          ],
          response_format: { type: "json_object" },
        }),
        30_000,
        `Image prompts for winner concept ${concept.id}`
      );

      const promptContent = typeof promptResult.choices[0]?.message?.content === "string"
        ? promptResult.choices[0].message.content
        : "";
      const parsed = JSON.parse(promptContent);
      return {
        concept,
        promptA: parsed.variation_a ?? parsed.prompt ?? "",
        promptB: parsed.variation_b ?? "",
        promptC: parsed.variation_c ?? "",
      };
    } catch (err) {
      console.warn(`[Pipeline] Prompt generation failed for winner concept ${concept.id}:`, err);
      return null;
    }
  });

  const promptResults = await Promise.allSettled(promptTasks);
  const validPromptSets = promptResults
    .map((r) => (r.status === "fulfilled" ? r.value : null))
    .filter((r): r is PromptSet => r !== null && (r.promptA.length > 0 || r.promptB.length > 0 || r.promptC.length > 0));

  console.log(`[Pipeline] Got ${validPromptSets.length} valid prompt sets, generating ${validPromptSets.length * 3} images in parallel...`);

  // ── Step 4: Generate all images in parallel (up to 15) ───────────────
  type ImageTask = { concept: typeof winners[0]; variation: "A" | "B" | "C"; prompt: string };
  const allImageTasks: ImageTask[] = [];

  for (const ps of validPromptSets) {
    if (ps.promptA) allImageTasks.push({ concept: ps.concept, variation: "A", prompt: ps.promptA });
    if (ps.promptB) allImageTasks.push({ concept: ps.concept, variation: "B", prompt: ps.promptB });
    if (ps.promptC) allImageTasks.push({ concept: ps.concept, variation: "C", prompt: ps.promptC });
  }

  const imageResults = await Promise.allSettled(
    allImageTasks.map(async (task) => {
      try {
        const img = await withTimeout(
          generateImage({ prompt: task.prompt }),
          IMAGE_GEN_TIMEOUT_MS,
          `Image ${task.variation} for concept ${task.concept.id}`
        );
        const rawUrl = img.url ?? null;
        // Immediately process the generated image into a production-ready transparent PNG.
        // This runs AI background removal once at generation time so the compositor
        // can composite directly without any background removal at render time.
        if (rawUrl) {
          try {
            await processDesignForProduction(rawUrl, task.concept.id, task.variation, task.prompt);
          } catch (procErr) {
            // Non-fatal: log and continue. The compositor will fall back to the raw image.
            console.warn(`[Pipeline] Production processing failed for concept ${task.concept.id} variation ${task.variation}:`, procErr);
          }
        }
        return { ...task, imageUrl: rawUrl, error: null };
      } catch (err) {
        console.warn(`[Pipeline] Image ${task.variation} failed for concept ${task.concept.id}:`, err);
        return { ...task, imageUrl: null, error: err };
      }
    })
  );

  // ── Step 5: Group results by concept and save to DB ──────────────────
  const conceptImageMap = new Map<number, { promptA?: string; promptB?: string; promptC?: string; urlA?: string | null; urlB?: string | null; urlC?: string | null }>();

  let imagesGenerated = 0;

  for (const result of imageResults) {
    if (result.status !== "fulfilled") continue;
    const { concept, variation, prompt, imageUrl } = result.value;

    if (imageUrl) imagesGenerated++;

    const existing = conceptImageMap.get(concept.id) ?? {};
    if (variation === "A") { existing.promptA = prompt; existing.urlA = imageUrl; }
    if (variation === "B") { existing.promptB = prompt; existing.urlB = imageUrl; }
    if (variation === "C") { existing.promptC = prompt; existing.urlC = imageUrl; }
    conceptImageMap.set(concept.id, existing);
  }

  // Write all image data to DB
  // IMMUTABILITY GUARD: Only pass fields that have actual values — never pass null for URLs.
  // The updateConceptImages guard also protects against this, but defense-in-depth.
  for (const [conceptId, imgs] of Array.from(conceptImageMap)) {
    const update: Parameters<typeof updateConceptImages>[1] = {};
    if (imgs.promptA) update.imagePromptA = imgs.promptA;
    if (imgs.promptB) update.imagePromptB = imgs.promptB;
    if (imgs.promptC) update.imagePromptC = imgs.promptC;
    if (imgs.urlA) update.imageUrlA = imgs.urlA;
    if (imgs.urlB) update.imageUrlB = imgs.urlB;
    if (imgs.urlC) update.imageUrlC = imgs.urlC;
    if (Object.keys(update).length > 0) {
      await updateConceptImages(conceptId, update);
    }
  }

  await updateRunImagesGenerated(runId, imagesGenerated);
  console.log(`[Pipeline/Stage6] Image generation complete: ${imagesGenerated}/${maxImages} images created for ${winners.length} winners (elapsed: ${Date.now() - stageStart}ms)`);

  return imagesGenerated;
}

// ─── Stage 7: Report & Notify ───────────────────────────────────────────

async function stageReport(runId: number, imagesGenerated: number): Promise<void> {
  const bookRecords = await getBooksByRunId(runId);
  const conceptRecords = await getConceptsByRunId(runId);

  const topBook = bookRecords[0];
  const totalConcepts = conceptRecords.length;
  const highScorers = conceptRecords.filter(
    (c) => c.trendScore !== null && c.trendScore >= HIGH_SCORE_THRESHOLD
  );

  // Build a summary for the owner notification
  const top3 = bookRecords.slice(0, 3);
  const trendArrow = (dir: string | null) => {
    if (dir === "up") return "\u2191";
    if (dir === "down") return "\u2193";
    if (dir === "stable") return "\u2192";
    return "\u2605"; // new
  };
  const summaryLines = top3.map(
    (b, i) => {
      const arrow = trendArrow(b.trendDirection);
      const deltaStr = b.scoreDelta != null ? ` (${b.scoreDelta > 0 ? "+" : ""}${b.scoreDelta})` : "";
      const streakStr = (b.streakCount ?? 1) > 1 ? ` | ${b.streakCount} runs` : " | NEW";
      return `${i + 1}. ${arrow} "${b.title}" by ${b.author} \u2014 Score: ${b.trendScoreTotal ?? "N/A"}${deltaStr}${streakStr} | ${b.subgenre ?? "N/A"}`;
    }
  );

  const content = [
    `Pipeline run #${runId} completed successfully.`,
    `Books processed: ${bookRecords.length}`,
    `Design concepts generated: ${totalConcepts}`,
    `High-scoring concepts: ${highScorers.length}`,
    `Design images generated: ${imagesGenerated}`,
    "",
    "Top 3 Picks:",
    ...summaryLines,
  ].join("\n");

  await completeRun(
    runId,
    bookRecords.length,
    imagesGenerated,
    topBook?.title,
    topBook?.isbn ?? undefined
  );

  try {
    await notifyOwner({
      title: `Design Bot Run #${runId} Complete`,
      content,
    });
  } catch (err) {
    console.warn("[Pipeline] Owner notification failed:", err);
  }
}

// ─── Cross-Run Trend Comparison ──────────────────────────────────────────

/**
 * Compare books in the current run with the most recent completed run.
 * For each book that appeared in both runs (matched by ISBN), compute:
 * - trendDirection: "up" if score improved, "down" if dropped, "stable" if within ±10
 * - scoreDelta: current score - previous score
 * - previousTrendScore: the score from the previous run
 * - previousRank: the rank from the previous run
 * - streakCount: how many consecutive runs this book has appeared
 *
 * Books not found in the previous run get trendDirection = "new".
 */
async function computeCrossRunTrends(runId: number): Promise<void> {
  try {
    const prevRunId = await getPreviousCompletedRunId(runId);
    const currentBooks = await getBooksByRunId(runId);

    if (!prevRunId) {
      // First run ever — all books are "new"
      for (const book of currentBooks) {
        await updateBookTrend(book.id, {
          trendDirection: "new",
          previousTrendScore: null,
          scoreDelta: null,
          previousRank: null,
          streakCount: 1,
        });
      }
      console.log(`[Pipeline] First run — all ${currentBooks.length} books marked as new`);
      return;
    }

    const prevBooksMap = await getBooksByRunIdIndexedByIsbn(prevRunId);

    let upCount = 0, downCount = 0, stableCount = 0, newCount = 0;

    for (const book of currentBooks) {
      const prevBook = book.isbn ? prevBooksMap.get(book.isbn) : null;

      if (!prevBook) {
        // New to the list
        await updateBookTrend(book.id, {
          trendDirection: "new",
          previousTrendScore: null,
          scoreDelta: null,
          previousRank: null,
          streakCount: 1,
        });
        newCount++;
        continue;
      }

      const currentScore = book.trendScoreTotal ?? 0;
      const prevScore = prevBook.trendScoreTotal ?? 0;
      const delta = currentScore - prevScore;
      const prevStreak = prevBook.streakCount ?? 1;

      let direction: "up" | "down" | "stable";
      if (delta > 10) {
        direction = "up";
        upCount++;
      } else if (delta < -10) {
        direction = "down";
        downCount++;
      } else {
        direction = "stable";
        stableCount++;
      }

      await updateBookTrend(book.id, {
        trendDirection: direction,
        previousTrendScore: prevScore,
        scoreDelta: delta,
        previousRank: prevBook.rank ?? null,
        streakCount: prevStreak + 1,
      });
    }

    console.log(
      `[Pipeline] Trend comparison: ${upCount} up, ${downCount} down, ${stableCount} stable, ${newCount} new`
    );
  } catch (err) {
    console.warn("[Pipeline] Cross-run trend comparison failed (non-fatal):", err);
  }
}

// ─── Orchestrator ──────────────────────────────────────────────────────────

export async function runPipeline(opts: {
  workspaceId: string;
  workspaceType: "nyt" | "niche_hunter";
  nicheProfile?: NicheProfile;
  nytApiKey?: string;
  etsyApiKey?: string;
}): Promise<number> {
  const { workspaceId, workspaceType, nicheProfile, nytApiKey, etsyApiKey } = opts;
  const runId = await createRun(workspaceId);

  // Keep-alive: periodically update the run's stage label to prevent Cloud Run idle shutdown.
  // Cloud Run considers a process "idle" when it has no active work. By writing to the DB
  // every 30s, we keep the event loop active and the instance alive.
  const keepAliveInterval = setInterval(async () => {
    try {
      const run = await getRunById(runId);
      if (run && run.status === "running") {
        // Touch the DB to keep the connection and process alive
        await updateRunStage(runId, run.currentStage ?? 1, run.stageLabel ?? "Processing...");
        // Heartbeat: lets recoverStaleRuns distinguish "actively running" from "server died"
        await updateRunHeartbeat(runId);
      }
    } catch {
      // Non-critical: keep-alive failure doesn't stop the pipeline
    }
  }, 30_000);

  // Pre-validate Etsy API key before starting the pipeline.
  // If the key returns 401/403, set it to undefined so we skip all Etsy calls.
  let validatedEtsyKey = etsyApiKey;
  if (etsyApiKey) {
    try {
      const testUrl = `https://openapi.etsy.com/v3/application/listings/active?keywords=test&limit=1`;
      const testResp = await fetch(testUrl, {
        headers: { "x-api-key": etsyApiKey },
        signal: AbortSignal.timeout(5000),
      });
      if (testResp.status === 401 || testResp.status === 403) {
        console.log("[Pipeline] Etsy API key not yet active (403) — skipping all Etsy validation this run");
        validatedEtsyKey = undefined;
      } else if (!testResp.ok) {
        console.log(`[Pipeline] Etsy API returned ${testResp.status} — skipping Etsy validation`);
        validatedEtsyKey = undefined;
      } else {
        console.log("[Pipeline] Etsy API key validated successfully");
      }
    } catch (err) {
      console.log("[Pipeline] Etsy API pre-check failed (timeout/network) — skipping Etsy validation");
      validatedEtsyKey = undefined;
    }
  }

  // Overall pipeline timeout — wraps the entire execution
  const pipelinePromise = (async () => {
    try {
      // Stage 1: Ingest — branch on workspace type
      let rawBooks: RawBook[];
      if (workspaceType === "niche_hunter") {
        await updateRunStage(runId, 1, "Scanning niche signals (Reddit + Etsy)...");
        rawBooks = await withSelfHeal({
          label: "Stage 1: Niche Ingest",
          subsystem: "pipeline",
          primaryFn: () => stageNicheIngest(nicheProfile!, validatedEtsyKey),
          maxRetries: 2,
          baseDelayMs: 2000,
          runId,
        });
      } else {
        await updateRunStage(runId, 1, "Fetching NYT Best Sellers...");
        rawBooks = await withSelfHeal({
          label: "Stage 1: NYT Ingest",
          subsystem: "pipeline",
          primaryFn: () => withCircuitBreaker(
            { name: "nyt_api", failureThreshold: 3, resetTimeoutMs: 60000 },
            () => stageIngest(nytApiKey!)
          ),
          maxRetries: 2,
          baseDelayMs: 2000,
          runId,
        });
      }

      // FOREVER-ID: Upsert books by ISBN — reuse existing rows, only create new ones for new ISBNs
      const bookInserts: InsertBook[] = rawBooks.map((b) => ({
        runId,
        title: b.title,
        author: b.author,
        isbn: b.isbn,
        coverUrl: b.coverUrl,
        synopsis: b.synopsis,
        rank: b.rank,
        weeksOnList: b.weeksOnList,
      }));
      const bookIds = await upsertBooksByIsbn(bookInserts);

      // Fetch canonical books by their forever IDs
      let dbBooks = await getBooksByIds(bookIds);

      // Write booksProcessed early so it's persisted even if Stage 6+ fails
      await updateRunBooksProcessed(runId, dbBooks.length);

      // Stage 2: Extract + Fan Culture (self-healing: retry LLM calls)
      await updateRunStage(runId, 2, "Extracting book metadata + fan culture...");
      await withSelfHeal({
        label: "Stage 2: Extract + Fan Culture",
        subsystem: "pipeline",
        primaryFn: () => stageExtract(
          dbBooks.map((b) => ({
            id: b.id,
            title: b.title,
            author: b.author,
            synopsis: b.synopsis,
          }))
        ),
        maxRetries: 2,
        baseDelayMs: 3000,
        runId,
      });

      // Refresh books with extraction data (use canonical IDs)
      dbBooks = await getBooksByIds(bookIds);

      // Stage 2b: World Bible Extraction (runs in parallel with forum scraping setup)
      await updateRunStage(runId, 2, "Building book visual universe (World Bible)...");
      await withSelfHeal({
        label: "Stage 2b: World Bible",
        subsystem: "pipeline",
        primaryFn: () => stageWorldBible(
          dbBooks.map((b) => ({
            id: b.id,
            title: b.title,
            author: b.author,
            synopsis: b.synopsis,
            mood: b.mood,
            setting: b.setting,
            subgenre: b.subgenre,
          }))
        ),
        defaultValue: undefined, // Graceful: if World Bible fails, continue without it
        maxRetries: 2,
        baseDelayMs: 3000,
        runId,
      });

      // Refresh books again to get worldBible data
      dbBooks = await getBooksByIds(bookIds);

      // Stage 2c: Forum Scraping (self-healing: graceful degradation, circuit breaker per forum)
      await updateRunStage(runId, 2, "Scraping fan forums (Goodreads, StoryGraph, Reddit, Fable, Book Riot)...");
      const forumSignalsMap = new Map<number, ForumSignals>();
      await withSelfHeal({
        label: "Stage 2b: Forum Scraping",
        subsystem: "pipeline",
        primaryFn: async () => {
          const forumResults = await Promise.allSettled(
            dbBooks.map(async (b) => {
              const signals = await withCircuitBreaker(
                { name: "forum_scraper", failureThreshold: 4, resetTimeoutMs: 120000 },
                () => scrapeAllForums(b.title, b.author)
              );
              await updateBookForumSignals(b.id, signals);
              forumSignalsMap.set(b.id, signals);
              return { bookId: b.id, signals };
            })
          );
          const successCount = forumResults.filter(r => r.status === "fulfilled").length;
          console.log(`[Pipeline] Forum scraping complete: ${successCount}/${dbBooks.length} books scraped`);
        },
        defaultValue: undefined, // Graceful: if all forums fail, continue without signals
        maxRetries: 1,
        runId,
      });

      // Stage 3: Book Niche Research (self-healing: retry LLM)
      await updateRunStage(runId, 3, "Researching book niches...");
      await withSelfHeal({
        label: "Stage 3: Niche Research",
        subsystem: "pipeline",
        primaryFn: () => stageNicheResearch(
          runId,
          dbBooks.map((b) => ({
            id: b.id,
            title: b.title,
            author: b.author,
            subgenre: b.subgenre,
            mood: b.mood,
            fanCulture: b.fanCulture,
          }))
        ),
        maxRetries: 2,
        baseDelayMs: 3000,
        runId,
      });

      // Build niche research map for concept generation
      const nicheRecords = await getNicheResearchByRunId(runId);
      const nicheMap = new Map<number, { fanConversations: any; designStyles: any; whiteSpace: any }>();
      for (const nr of nicheRecords) {
        nicheMap.set(nr.bookId, {
          fanConversations: nr.fanConversations,
          designStyles: nr.designStyles,
          whiteSpace: nr.whiteSpace,
        });
      }

      // Stage 4: Generate 5 Concepts per Book (self-healing: retry LLM)
      await updateRunStage(runId, 4, "Generating niche-informed design concepts...");
      await withSelfHeal({
        label: "Stage 4: Generate Concepts",
        subsystem: "pipeline",
        primaryFn: () => stageGenerate(
          dbBooks.map((b) => ({
            id: b.id,
            runId: b.runId,
            title: b.title,
            subgenre: b.subgenre,
            mood: b.mood,
            setting: b.setting,
            dominantColors: b.dominantColors,
            visualMotifs: b.visualMotifs,
            typographyStyle: b.typographyStyle,
            fanCulture: b.fanCulture,
          })),
          nicheMap,
          forumSignalsMap
        ),
        maxRetries: 2,
        baseDelayMs: 3000,
        runId,
      });

      // Stage 5: Score + Etsy Validation + Forum Signal Boosts (self-healing: retry + Etsy circuit breaker)
      const etsyLabel = validatedEtsyKey
        ? "Scoring concepts + Etsy market validation..."
        : "Scoring concepts (Etsy skipped — key pending)...";
      await updateRunStage(runId, 5, etsyLabel);
      await withSelfHeal({
        label: "Stage 5: Score + Validate",
        subsystem: "pipeline",
        primaryFn: () => stageScoreAndValidate(runId, validatedEtsyKey),
        maxRetries: 2,
        baseDelayMs: 3000,
        runId,
      });

      // Apply forum signal boosts to book scores
      try {
        const refreshedBooks = await getBooksByRunId(runId);
        for (const book of refreshedBooks) {
          const signals = forumSignalsMap.get(book.id) ?? book.forumSignals as ForumSignals | null;
          if (signals) {
            const { socialMomentumBoost, audienceSizeBoost, realDataSources, summary } = computeForumScore(signals);
            if (socialMomentumBoost !== 0 || audienceSizeBoost !== 0) {
              const newSocial = Math.max(0, Math.min(100, (book.socialMomentum ?? 0) + socialMomentumBoost));
              const newAudience = Math.max(0, Math.min(100, (book.audienceSize ?? 0) + audienceSizeBoost));
              const newTotal = newSocial + (book.designNovelty ?? 0) + newAudience;
              await updateBookScores(book.id, {
                trendScoreTotal: newTotal,
                socialMomentum: newSocial,
                socialRationale: `${book.socialRationale ?? ""} [Forum boost: ${socialMomentumBoost > 0 ? "+" : ""}${socialMomentumBoost} from ${realDataSources.join(", ") || "LLM estimate"}]`,
                designNovelty: book.designNovelty ?? 0,
                designRationale: book.designRationale ?? "",
                audienceSize: newAudience,
                audienceRationale: `${book.audienceRationale ?? ""} [Forum boost: ${audienceSizeBoost > 0 ? "+" : ""}${audienceSizeBoost} from ${realDataSources.join(", ") || "LLM estimate"}]`,
              });
              console.log(`[Pipeline] Forum boost for "${book.title}": social ${socialMomentumBoost > 0 ? "+" : ""}${socialMomentumBoost}, audience ${audienceSizeBoost > 0 ? "+" : ""}${audienceSizeBoost} (${summary})`);
            }
          }
        }
      } catch (boostErr) {
        console.warn("[Pipeline] Forum score boost failed (non-fatal):", boostErr);
      }

      // Cross-run trend comparison (runs after scoring, before image gen)
      await computeCrossRunTrends(runId);

      // ─── Stage 5.5: Compute Style Directives (non-blocking, graceful degradation) ────
      // Derives visual style intelligence from niche research + approved patterns + world bibles.
      // Stored on book rows so stageDesignExpansion can read them for prompt selection.
      await updateRunStage(runId, 5, "Computing visual style directives...");
      try {
        const { computeRunStyleDirectives } = await import("./styleIntelligence");
        const { updateBookStyleDirectives } = await import("./db");
        const freshBooks = await getBooksByRunId(runId);
        const nicheRecords = await getNicheResearchByRunId(runId);

        if (workspaceType === "niche_hunter") {
          const { getWorkspaceById } = await import("./workspaceDb");
          const { getTrendPatternsByWorkspace } = await import("./nicheHunterDb");
          const ws = await getWorkspaceById(workspaceId);
          const approvedPatterns = await getTrendPatternsByWorkspace(workspaceId, "approved");
          const directive = await computeRunStyleDirectives({
            workspaceType: "niche_hunter",
            baseProfile: ws?.styleProfile ?? undefined,
            override: ws?.styleOverride ?? undefined,
            approvedPatterns,
            nicheResearch: nicheRecords,
          });
          for (const book of freshBooks) {
            await updateBookStyleDirectives(book.id, directive);
          }
          console.log(`[Pipeline/Stage5.5] Niche style directive computed: ${directive.primaryAesthetic}`);
        } else {
          // NYT: per-book style directives
          for (const book of freshBooks) {
            const bookNiche = nicheRecords.find(nr => nr.bookId === book.id);
            const directive = await computeRunStyleDirectives({
              workspaceType: "nyt",
              book: {
                title: book.title,
                subgenre: book.subgenre,
                mood: book.mood,
                setting: book.setting,
                fanCulture: book.fanCulture,
                worldBible: book.worldBible as any,
              },
              nicheResearch: bookNiche,
            });
            await updateBookStyleDirectives(book.id, directive);
          }
          console.log(`[Pipeline/Stage5.5] NYT per-book style directives computed for ${freshBooks.length} books`);
        }
      } catch (styleErr) {
        console.warn("[Pipeline/Stage5.5] Style intelligence failed (non-fatal, falling back to legacy prompts):", styleErr);
      }

      // ─── Browser Signal Re-extraction (fire-and-forget, non-blocking) ────
      // After Stage 5, the frontend BrowserScraper may submit enriched signals.
      // We kick off signal re-extraction asynchronously so it NEVER blocks
      // Stage 6 image generation. Cloud Run has a 5-min timeout.
      void (async () => {
        try {
          // Small delay to let any in-flight browser signal submissions land
          await new Promise((r) => setTimeout(r, 5_000));
          const enrichedBooks = await getBooksByRunId(runId);
          let signalTagsUpdated = 0;
          for (const book of enrichedBooks) {
            const signals = book.forumSignals as ForumSignals | null;
            if (!signals) continue;
            const crossSignals = extractCrossSourceSignals(signals);
            if (crossSignals.length === 0) continue;
            const tagLabels = crossSignals.map((s) => s.theme);
            const concepts = await getConceptsByBookId(book.id);
            for (const concept of concepts) {
              if ((concept.trendScore ?? 0) >= 200) {
                await updateConceptSignalTags(concept.id, tagLabels);
                signalTagsUpdated++;
              }
            }
          }
          console.log(`[Pipeline] Browser signal re-extraction complete: ${signalTagsUpdated} concepts updated`);
        } catch (signalErr) {
          console.warn("[Pipeline] Browser signal re-extraction failed (non-fatal):", signalErr);
        }
      })();

      // Stage 6: Design Expansion + Image Generation (self-healing: graceful degradation)
      await updateRunStage(runId, 6, "Generating design images for top concepts...");
      let imagesGenerated = 0;
      const imgResult = await withSelfHeal<number>({
        label: "Stage 6: Image Generation",
        subsystem: "pipeline",
        primaryFn: async () => {
          const count = await stageDesignExpansion(runId);
          await updateRunImagesGenerated(runId, count);
          return count;
        },
        defaultValue: 0, // Graceful: if image gen fails entirely, continue with 0 images
        maxRetries: 1,
        baseDelayMs: 5000,
        runId,
      });
      imagesGenerated = imgResult;

      // Stage 7: Report & Notify
      await updateRunStage(runId, 7, "Generating report...");
      await stageReport(runId, imagesGenerated);

      return runId;
    } catch (err: any) {
      const errorMsg = err?.message ?? String(err);
      await failRun(runId, errorMsg);

      try {
        await notifyOwner({
          title: `Design Bot Run #${runId} Failed`,
          content: `Pipeline run #${runId} failed with error:\n${errorMsg}`,
        });
      } catch {
        // Notification failure is non-critical
      }

      throw err;
    } finally {
      clearInterval(keepAliveInterval);
    }
  })();

  // Wrap with overall timeout
  try {
    return await withTimeout(
      pipelinePromise,
      OVERALL_PIPELINE_TIMEOUT_MS,
      "Overall pipeline execution"
    );
  } catch (err: any) {
    // If the pipeline timed out, mark it as failed
    const errorMsg = err?.message ?? String(err);
    if (errorMsg.includes("Timeout")) {
      try {
        await failRun(runId, `Pipeline timed out after ${OVERALL_PIPELINE_TIMEOUT_MS / 1000}s: ${errorMsg}`);
        await notifyOwner({
          title: `Design Bot Run #${runId} Timed Out`,
          content: `Pipeline run #${runId} exceeded the ${OVERALL_PIPELINE_TIMEOUT_MS / 1000}s time limit and was automatically stopped.\n\nError: ${errorMsg}`,
        });
      } catch {
        // Best effort
      }
    }
    throw err;
  } finally {
    clearInterval(keepAliveInterval);
  }
}

// ─── Stale Run Recovery ─────────────────────────────────────────────────

/**
 * Resume any "running" runs that were interrupted by a server restart.
 * Instead of marking them as failed, we attempt to resume from the last completed stage.
 * If a run has been stuck for over 30 minutes (absolute max), we mark it as failed.
 * Called on server startup.
 */
export async function recoverStaleRuns(maxAgeMs: number = 15 * 60 * 1000): Promise<void> {
  try {
    const { getDb, getBooksByRunId, getConceptsByRunId, getNicheResearchByRunId } = await import("./db");
    const { botRuns } = await import("../drizzle/schema");
    const { eq } = await import("drizzle-orm");
    const db = await getDb();
    if (!db) return;

    // Find ALL running runs (not just old ones)
    const runningRuns = await db
      .select()
      .from(botRuns)
      .where(eq(botRuns.status, "running"));

    if (runningRuns.length === 0) return;

    const ABSOLUTE_MAX_AGE_MS = 30 * 60 * 1000; // 30 min absolute max
    const HEARTBEAT_STALE_MS = 2 * 60 * 1000; // 2 min — if no heartbeat for 2 min, server likely died

    for (const run of runningRuns) {
      const ageMs = Date.now() - new Date(run.createdAt).getTime();

      // If the run is over 30 minutes old, it's truly stuck — mark as failed
      if (ageMs > ABSOLUTE_MAX_AGE_MS) {
        console.log(`[Pipeline] Run #${run.id} is over 30 min old — marking as failed`);
        await db
          .update(botRuns)
          .set({
            status: "failed",
            errorLog: `Automatically failed: run exceeded 30-minute absolute time limit.`,
            completedAt: new Date(),
          })
          .where(eq(botRuns.id, run.id));
        continue;
      }

      // Check heartbeat: if recent, the run is still actively executing on another instance
      if (run.lastHeartbeat) {
        const heartbeatAge = Date.now() - new Date(run.lastHeartbeat).getTime();
        if (heartbeatAge < HEARTBEAT_STALE_MS) {
          console.log(`[Pipeline] Run #${run.id} has recent heartbeat (${Math.round(heartbeatAge / 1000)}s ago) — still active, skipping`);
          continue;
        }
        console.log(`[Pipeline] Run #${run.id} heartbeat stale (${Math.round(heartbeatAge / 1000)}s ago) — server likely died, will resume`);
      } else if (ageMs < 90_000) {
        // No heartbeat yet but run is less than 90s old — might still be starting up
        console.log(`[Pipeline] Run #${run.id} is young (${Math.round(ageMs / 1000)}s) with no heartbeat yet — waiting`);
        continue;
      }

      // Attempt to resume from the last completed stage
      const lastStage = run.currentStage ?? 0;
      console.log(`[Pipeline] Attempting to resume run #${run.id} from stage ${lastStage}`);

      // Determine what data already exists to figure out the actual resume point
      const existingBooks = await getBooksByRunId(run.id);
      const existingConcepts = await getConceptsByRunId(run.id);
      const existingNiche = await getNicheResearchByRunId(run.id);

      let resumeFromStage = 1; // Default: start over

      if (existingBooks.length > 0) {
        // Stage 1 completed (books ingested)
        resumeFromStage = 2;

        // Check if extraction happened (Stage 2)
        const hasExtraction = existingBooks.some(b => b.subgenre || b.mood || b.fanCulture);
        if (hasExtraction) {
          resumeFromStage = 3;

          // Check if niche research happened (Stage 3)
          if (existingNiche.length > 0) {
            resumeFromStage = 4;

            // Check if concepts were generated (Stage 4)
            if (existingConcepts.length > 0) {
              resumeFromStage = 5;

              // Check if scoring happened (Stage 5)
              const hasScoring = existingConcepts.some(c => c.trendScore !== null && c.trendScore !== undefined);
              if (hasScoring) {
                resumeFromStage = 6;

                // Check if images were generated (Stage 6)
                const hasImages = existingConcepts.some(c => c.imageUrlA || c.imageUrlB || c.imageUrlC);
                if (hasImages) {
                  resumeFromStage = 7;
                }
              }
            }
          }
        }
      }

      console.log(`[Pipeline] Run #${run.id}: DB state indicates resume from stage ${resumeFromStage} (was at stage ${lastStage})`);

      // Fire-and-forget the resume
      resumePipeline(run.id, resumeFromStage).catch((err) => {
        console.error(`[Pipeline] Resume of run #${run.id} failed:`, err);
      });
    }
  } catch (err) {
    console.warn("[Pipeline] Stale run recovery failed:", err);
  }
}

/**
 * Resume a pipeline run from a specific stage.
 * Re-uses existing data from earlier stages.
 */
async function resumePipeline(runId: number, fromStage: number): Promise<void> {
  // Look up the run to determine workspace type
  const run = await getRunById(runId);
  const runWorkspaceId = run?.workspaceId ?? null;

  // Determine workspace type — default to "nyt" for legacy runs (workspaceId = null)
  let resumeWorkspaceType: "nyt" | "niche_hunter" = "nyt";
  let resumeNicheProfile: NicheProfile | undefined;
  if (runWorkspaceId) {
    const { getWorkspaceById } = await import("./workspaceDb");
    const ws = await getWorkspaceById(runWorkspaceId);
    if (ws) {
      resumeWorkspaceType = ws.workspaceType as "nyt" | "niche_hunter";
      resumeNicheProfile = ws.nicheProfile as NicheProfile | undefined;
    }
  }

  const nytApiKey = process.env.NYT_API_KEY;
  // Etsy v3 requires 'keystring:shared_secret' format in x-api-key header
  const rawEtsyKey = process.env.ETSY_API_KEY;
  const rawEtsySecret = process.env.ETSY_API_SECRET;
  const etsyApiKey = rawEtsyKey && rawEtsySecret
    ? `${rawEtsyKey}:${rawEtsySecret}`
    : rawEtsyKey || undefined;

  if (resumeWorkspaceType === "nyt" && !nytApiKey) {
    await failRun(runId, "Cannot resume: NYT_API_KEY not available");
    return;
  }

  // Pre-validate Etsy API key
  let validatedEtsyKey = etsyApiKey;
  if (etsyApiKey) {
    try {
      const testUrl = `https://openapi.etsy.com/v3/application/listings/active?keywords=test&limit=1`;
      const testResp = await fetch(testUrl, {
        headers: { "x-api-key": etsyApiKey },
        signal: AbortSignal.timeout(5000),
      });
      if (!testResp.ok) validatedEtsyKey = undefined;
    } catch {
      validatedEtsyKey = undefined;
    }
  }

  const keepAliveInterval = setInterval(async () => {
    try {
      const run = await getRunById(runId);
      if (run && run.status === "running") {
        await updateRunStage(runId, run.currentStage ?? 1, run.stageLabel ?? "Resuming...");
        await updateRunHeartbeat(runId);
      }
    } catch {}
  }, 30_000);

  try {
    let dbBooks = await getBooksByRunId(runId);
    const forumSignalsMap = new Map<number, ForumSignals>();

    // Stage 1: Ingest (only if we need to start from scratch)
    if (fromStage <= 1) {
      let rawBooks: RawBook[];
      if (resumeWorkspaceType === "niche_hunter") {
        await updateRunStage(runId, 1, "Resuming: Scanning niche signals (Reddit + Etsy)...");
        rawBooks = await withSelfHeal({
          label: "Resume Stage 1: Niche Ingest",
          subsystem: "pipeline",
          primaryFn: () => stageNicheIngest(resumeNicheProfile!, validatedEtsyKey),
          maxRetries: 2,
          baseDelayMs: 2000,
          runId,
        });
      } else {
        await updateRunStage(runId, 1, "Resuming: Fetching NYT Best Sellers...");
        rawBooks = await withSelfHeal({
          label: "Resume Stage 1: NYT Ingest",
          subsystem: "pipeline",
          primaryFn: () => stageIngest(nytApiKey!),
          maxRetries: 2,
          baseDelayMs: 2000,
          runId,
        });
      }
      const bookInserts: InsertBook[] = rawBooks.map((b) => ({
        runId,
        title: b.title,
        author: b.author,
        isbn: b.isbn,
        coverUrl: b.coverUrl,
        synopsis: b.synopsis,
        rank: b.rank,
        weeksOnList: b.weeksOnList,
      }));
      // FOREVER-ID: Upsert books by ISBN in resume path
      const resumeBookIds = await upsertBooksByIsbn(bookInserts);
      dbBooks = await getBooksByIds(resumeBookIds);
    }

    // Stage 2: Extract + Forum Scraping
    if (fromStage <= 2) {
      await updateRunStage(runId, 2, "Resuming: Extracting metadata + forum scraping...");
      await withSelfHeal({
        label: "Resume Stage 2: Extract",
        subsystem: "pipeline",
        primaryFn: () => stageExtract(
          dbBooks.map((b) => ({
            id: b.id,
            title: b.title,
            author: b.author,
            synopsis: b.synopsis,
          }))
        ),
        maxRetries: 2,
        baseDelayMs: 3000,
        runId,
      });
      dbBooks = await getBooksByIds(dbBooks.map(b => b.id));
      // World Bible extraction
      await updateRunStage(runId, 2, "Resuming: Building World Bible...");
      await withSelfHeal({
        label: "Resume Stage 2b: World Bible",
        subsystem: "pipeline",
        primaryFn: () => stageWorldBible(
          dbBooks.map((b) => ({
            id: b.id,
            title: b.title,
            author: b.author,
            synopsis: b.synopsis,
            mood: b.mood,
            setting: b.setting,
            subgenre: b.subgenre,
          }))
        ),
        defaultValue: undefined,
        maxRetries: 2,
        baseDelayMs: 3000,
        runId,
      });
      dbBooks = await getBooksByIds(dbBooks.map(b => b.id));
      // Forum scraping
      await updateRunStage(runId, 2, "Resuming: Scraping fan forums...");;
      await withSelfHeal({
        label: "Resume Stage 2b: Forum Scraping",
        subsystem: "pipeline",
        primaryFn: async () => {
          const forumResults = await Promise.allSettled(
            dbBooks.map(async (b) => {
              const signals = await scrapeAllForums(b.title, b.author);
              await updateBookForumSignals(b.id, signals);
              forumSignalsMap.set(b.id, signals);
              return { bookId: b.id, signals };
            })
          );
          const successCount = forumResults.filter(r => r.status === "fulfilled").length;
          console.log(`[Pipeline Resume] Forum scraping: ${successCount}/${dbBooks.length} books`);
        },
        defaultValue: undefined,
        maxRetries: 1,
        runId,
      });
    }

    // Stage 3: Niche Research
    if (fromStage <= 3) {
      await updateRunStage(runId, 3, "Resuming: Researching book niches...");
      await withSelfHeal({
        label: "Resume Stage 3: Niche Research",
        subsystem: "pipeline",
        primaryFn: () => stageNicheResearch(
          runId,
          dbBooks.map((b) => ({
            id: b.id,
            title: b.title,
            author: b.author,
            subgenre: b.subgenre,
            mood: b.mood,
            fanCulture: b.fanCulture,
          }))
        ),
        maxRetries: 2,
        baseDelayMs: 3000,
        runId,
      });
    }

    // Build niche map
    const nicheRecords = await getNicheResearchByRunId(runId);
    const nicheMap = new Map<number, { fanConversations: any; designStyles: any; whiteSpace: any }>();
    for (const nr of nicheRecords) {
      nicheMap.set(nr.bookId, {
        fanConversations: nr.fanConversations,
        designStyles: nr.designStyles,
        whiteSpace: nr.whiteSpace,
      });
    }

    // Stage 4: Generate Concepts
    if (fromStage <= 4) {
      await updateRunStage(runId, 4, "Resuming: Generating design concepts...");
      await withSelfHeal({
        label: "Resume Stage 4: Generate Concepts",
        subsystem: "pipeline",
        primaryFn: () => stageGenerate(
          dbBooks.map((b) => ({
            id: b.id,
            runId: b.runId,
            title: b.title,
            subgenre: b.subgenre,
            mood: b.mood,
            setting: b.setting,
            dominantColors: b.dominantColors,
            visualMotifs: b.visualMotifs,
            typographyStyle: b.typographyStyle,
            fanCulture: b.fanCulture,
          })),
          nicheMap,
          forumSignalsMap
        ),
        maxRetries: 2,
        baseDelayMs: 3000,
        runId,
      });
    }

    // Stage 5: Score + Validate
    if (fromStage <= 5) {
      const etsyLabel = validatedEtsyKey
        ? "Resuming: Scoring + Etsy validation..."
        : "Resuming: Scoring (Etsy skipped)...";
      await updateRunStage(runId, 5, etsyLabel);
      await withSelfHeal({
        label: "Resume Stage 5: Score + Validate",
        subsystem: "pipeline",
        primaryFn: () => stageScoreAndValidate(runId, validatedEtsyKey),
        maxRetries: 2,
        baseDelayMs: 3000,
        runId,
      });

      // Apply forum signal boosts
      try {
        const refreshedBooks = await getBooksByRunId(runId);
        for (const book of refreshedBooks) {
          const signals = forumSignalsMap.get(book.id) ?? book.forumSignals as ForumSignals | null;
          if (signals) {
            const { socialMomentumBoost, audienceSizeBoost, realDataSources, summary } = computeForumScore(signals);
            if (socialMomentumBoost !== 0 || audienceSizeBoost !== 0) {
              const newSocial = Math.max(0, Math.min(100, (book.socialMomentum ?? 0) + socialMomentumBoost));
              const newAudience = Math.max(0, Math.min(100, (book.audienceSize ?? 0) + audienceSizeBoost));
              const newTotal = newSocial + (book.designNovelty ?? 0) + newAudience;
              await updateBookScores(book.id, {
                trendScoreTotal: newTotal,
                socialMomentum: newSocial,
                socialRationale: `${book.socialRationale ?? ""} [Forum boost: ${socialMomentumBoost > 0 ? "+" : ""}${socialMomentumBoost}]`,
                designNovelty: book.designNovelty ?? 0,
                designRationale: book.designRationale ?? "",
                audienceSize: newAudience,
                audienceRationale: `${book.audienceRationale ?? ""} [Forum boost: ${audienceSizeBoost > 0 ? "+" : ""}${audienceSizeBoost}]`,
              });
            }
          }
        }
      } catch (boostErr) {
        console.warn("[Pipeline Resume] Forum boost failed (non-fatal):", boostErr);
      }

      // Cross-run trends
      await computeCrossRunTrends(runId);
    }

    // Stage 6: Image Generation
    let imagesGenerated = 0;
    if (fromStage <= 6) {
      await updateRunStage(runId, 6, "Resuming: Generating images for top concepts...");
      const imgResult = await withSelfHeal<number>({
        label: "Resume Stage 6: Image Generation",
        subsystem: "pipeline",
        primaryFn: async () => {
          const count = await stageDesignExpansion(runId);
          await updateRunImagesGenerated(runId, count);
          return count;
        },
        defaultValue: 0,
        maxRetries: 1,
        baseDelayMs: 5000,
        runId,
      });
      imagesGenerated = imgResult;
    }

    // Stage 7: Report
    if (fromStage <= 7) {
      await updateRunStage(runId, 7, "Resuming: Generating report...");
      await stageReport(runId, imagesGenerated);
    }

    console.log(`[Pipeline] Successfully resumed run #${runId} from stage ${fromStage}`);
  } catch (err: any) {
    const errorMsg = err?.message ?? String(err);
    await failRun(runId, `Resume failed from stage ${fromStage}: ${errorMsg}`);
    console.error(`[Pipeline] Resume of run #${runId} failed:`, errorMsg);

    try {
      await notifyOwner({
        title: `Design Bot Run #${runId} Resume Failed`,
        content: `Pipeline run #${runId} failed during resume from stage ${fromStage}:\n${errorMsg}`,
      });
    } catch {}
  } finally {
    clearInterval(keepAliveInterval);
  }
}

/**
 * Regenerate images for the top winner concepts in a completed run.
 * Used when a run completed with 0 images (e.g., due to timeout during Stage 6).
 * Also re-runs scoring (Stage 5) if all concepts have NULL trendScore (scoring timed out).
 * Safe to call multiple times — only regenerates concepts with null imageUrlA.
 */
export async function regenerateImagesForRun(runId: number): Promise<number> {
  console.log(`[Pipeline] Regenerating images for run #${runId}...`);

  // Check if scoring needs to be re-run (all concepts have NULL trendScore)
  const concepts = await getConceptsByRunId(runId);
  const allUnscored = concepts.length > 0 && concepts.every(c => c.trendScore === null);
  if (allUnscored) {
    console.log(`[Pipeline] All ${concepts.length} concepts have NULL trendScore — re-running Stage 5 scoring before image generation`);
    try {
      // Etsy v3 requires 'keystring:shared_secret' format
      const rawKey = process.env.ETSY_API_KEY;
      const rawSecret = process.env.ETSY_API_SECRET;
      const etsyKey = rawKey && rawSecret ? `${rawKey}:${rawSecret}` : rawKey || undefined;
      await stageScoreAndValidate(runId, etsyKey);
      console.log(`[Pipeline] Re-scoring complete for run #${runId}`);
    } catch (err) {
      console.error(`[Pipeline] Re-scoring failed for run #${runId}:`, err);
      // Continue anyway — stageDesignExpansion will log 0 scored concepts
    }
  }

  const count = await stageDesignExpansion(runId);
  await updateRunImagesGenerated(runId, count);
  console.log(`[Pipeline] Image regeneration complete: ${count} images for run #${runId}`);
  return count;
}
