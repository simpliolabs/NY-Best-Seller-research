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
import { generateImage, generateGptImage2, generateGptImage2Edit } from "./_core/imageGeneration";
import { notifyOwner } from "./_core/notification";
import { snapshotGenerationToHistory } from "./revisionDb";
import { STYLE_PLAYBOOK } from "../shared/styleProfile";
import { getTrendPatternsByWorkspace } from "./nicheHunterDb";
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
  clearRunErrorAndComplete,
  updateRunBooksProcessed,
  getRunById,
  getPreviousCompletedRunId,
  getBooksByRunIdIndexedByIsbn,
  updateBookTrend,
  updateRunHeartbeat,
  updateConceptSignalTags,
  getConceptsByBookId,
  getDismissedConceptTagsByWorkspace,
  getConceptById,
  updateConceptStyle,
  updateConceptProductionUrl,
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
const DEFAULT_WINNERS_TO_GENERATE = 10; // default designs/scan (PO 2026-06-15 "MORE"); overridable 1–20 via pipelineConfig.winnersToGenerate in Settings
const IMAGES_PER_WINNER = 1; // scans-to-1 (PO 2026-06-11): ONE hero image per winner (was 3)
const IMAGE_GEN_TIMEOUT_MS = 60_000; // 60s timeout per image generation call
// Wall-clock budget scales with the winner count: more winners = more council + gpt-image-2 render time.
// Floor at the proven 15-min/5-winner budget (run #720001 hit the old 7-min cap mid-stage-6); ceiling at
// 25 min (Cloud Run background-task reaping risk beyond that).
const MIN_PIPELINE_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_PIPELINE_TIMEOUT_MS = 25 * 60 * 1000;
function pipelineTimeoutForWinners(winnerCount: number): number {
  return Math.min(MAX_PIPELINE_TIMEOUT_MS, Math.max(MIN_PIPELINE_TIMEOUT_MS, 9 * 60 * 1000 + winnerCount * 50 * 1000));
}

/**
 * How many top concepts get rendered this run. Honors the workspace's pipelineConfig.winnersToGenerate
 * setting (1–20, surfaced in Settings); falls back to DEFAULT_WINNERS_TO_GENERATE for legacy / no-workspace
 * runs or when the field is unset.
 */
async function resolveWinnerCount(runId: number): Promise<number> {
  const run = await getRunById(runId);
  if (!run?.workspaceId) return DEFAULT_WINNERS_TO_GENERATE;
  const { getWorkspaceById } = await import("./workspaceDb");
  const ws = await getWorkspaceById(run.workspaceId);
  const n = ws?.pipelineConfig?.winnersToGenerate;
  return typeof n === "number" && Number.isFinite(n)
    ? Math.min(20, Math.max(1, Math.floor(n)))
    : DEFAULT_WINNERS_TO_GENERATE;
}

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
    // image: the real bestseller listing image — captured (PO 2026-06-12 hybrid) so winners can be
    // rendered by EDITING a proven top-seller (NH-style), not text-to-image from scratch.
    let etsyTopics: Array<{ title: string; synopsis: string; rank: number; image?: string }> = [];

    if (etsyApiKey) {
      // Real Etsy API: fetch top listings for each keyword
      for (const keyword of nicheProfile.etsyKeywords.slice(0, 5)) {
        try {
          const url = `https://openapi.etsy.com/v3/application/listings/active?keywords=${encodeURIComponent(keyword)}&limit=10&sort_on=score&includes=Images`;
          // HARD-bound the fetch+parse with withTimeout (reliable Promise.race). AbortSignal.timeout
          // alone did NOT fire in production — a throttled Etsy connection hung Stage 1 for the whole
          // pipeline budget (runs 750001/780001 died in ingest, 0 signals). 9s/keyword → ≤45s total.
          const data = await withTimeout(
            (async () => {
              const resp = await fetch(url, {
                headers: { "x-api-key": etsyApiKey },
                signal: AbortSignal.timeout(8000),
              });
              if (!resp.ok) {
                const e = new Error(`Etsy ${resp.status}`) as Error & { status?: number };
                e.status = resp.status; // surface 401/403 to break the loop in catch
                throw e;
              }
              return resp.json() as Promise<{ results?: any[] }>;
            })(),
            9_000,
            `Etsy fetch "${keyword}"`,
          );
          const results = data.results ?? [];
          for (const listing of results.slice(0, 3)) {
            const title = (listing.title ?? "").trim().slice(0, 80);
            if (!title || seenTitles.has(title.toLowerCase())) continue;
            seenTitles.add(title.toLowerCase());
            const favorites = listing.num_favorers ?? 0;
            const image = listing.images?.[0]?.url_fullxfull ?? listing.images?.[0]?.url_570xN ?? undefined;
            etsyTopics.push({
              title,
              synopsis: `Bestselling Etsy listing in "${keyword}" niche with ${favorites} favorites. Price: $${((listing.price?.amount ?? 0) / (listing.price?.divisor ?? 100)).toFixed(2)}. Tags: ${(listing.tags ?? []).slice(0, 5).join(", ")}.`,
              rank: Math.min(10, Math.max(1, Math.round(favorites / 50))),
              image,
            });
          }
          await new Promise((r) => setTimeout(r, 250)); // Etsy rate limit
        } catch (err) {
          const status = (err as { status?: number })?.status;
          if (status === 401 || status === 403) break; // key invalid — stop all Etsy calls
          console.warn(`[Pipeline/NicheIngest] Etsy fetch failed/timed out for "${keyword}":`, err);
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
        coverUrl: t.image ?? "", // real bestseller image → hybrid edit-mode rendering at stage 6
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

═══ STEP 4: PAIR THE PHRASE WITH A CONCRETE VISUAL SUBJECT ═══
A headline floating alone is a weak shirt. WHERE a "NICHE VISUAL VOCABULARY" block is provided below, MOST of your concepts (at least 3 of 5) must pair the fan phrase with a concrete visual SUBJECT drawn from that vocabulary — a mascot, character, creature, or visual gag — so the design has a focal graphic, not just type. Example: phrase "Just Dink It" → a cute llama mid-dink with the text below it. Put that subject explicitly in "layout_description" as the hero graphic the phrase sits with. A minority of concepts may be type-only when the typography itself is genuinely the strong idea — never default ALL five to plain text.

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
      "layout_description": "string — 2-3 sentences describing the visual layout. Name the concrete focal SUBJECT/graphic (a mascot, character, or visual gag from the niche vocabulary where provided) and how the headline sits with it. Reference the book's visual motifs and art style.",
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
6. Where a niche visual vocabulary is provided, at least 3 of 5 concepts must feature a concrete visual subject from it (not text-only).
7. Return ONLY the JSON object.`;

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
  forumSignalsMap?: Map<number, ForumSignals>,
  allowedStyles?: string[],
  // Workspace niche knowledge DNA (PO 2026-06-12) — the niche's own mascots/visual gags/jokes, so
  // concepts pair a fan phrase with a concrete visual subject ("llama" + "Just Dink It") instead of
  // flat text. Optional: NYT workspaces and unconfigured niches pass nothing → block omitted.
  culturalMap?: {
    animalMascots?: Array<{ animal?: string; visualTreatment?: string }>;
    funPoints?: Array<{ visualConcept?: string }>;
    transferableVisualConcepts?: Array<{ sourcePattern?: string; targetAdaptation?: string }>;
    physicalComedy?: Array<{ scenario?: string }>;
    insideJokes?: Array<{ joke?: string }>;
    catchphrases?: string[];
  }
): Promise<void> {
  // Build the niche visual-vocabulary block once (same for every book in this run).
  const cmBlocks: string[] = [];
  const mascots = (culturalMap?.animalMascots ?? []).filter(m => m.animal).map(m => m.animal + (m.visualTreatment ? ` (${m.visualTreatment})` : ""));
  if (mascots.length) cmBlocks.push(`Mascots/characters fans love: ${mascots.join("; ")}`);
  const visualConcepts = (culturalMap?.funPoints ?? []).map(f => f.visualConcept).filter((s): s is string => !!s);
  if (visualConcepts.length) cmBlocks.push(`Visual concepts that delight fans: ${visualConcepts.join("; ")}`);
  const transferable = (culturalMap?.transferableVisualConcepts ?? []).filter(t => t.sourcePattern && t.targetAdaptation).map(t => `${t.sourcePattern} → ${t.targetAdaptation}`);
  if (transferable.length) cmBlocks.push(`Transferable visual gags: ${transferable.join("; ")}`);
  const physical = (culturalMap?.physicalComedy ?? []).map(p => p.scenario).filter((s): s is string => !!s);
  if (physical.length) cmBlocks.push(`Funny visual scenarios: ${physical.join("; ")}`);
  const jokes = (culturalMap?.insideJokes ?? []).map(j => j.joke).filter((s): s is string => !!s);
  if (jokes.length) cmBlocks.push(`Inside jokes: ${jokes.join("; ")}`);
  if (culturalMap?.catchphrases?.length) cmBlocks.push(`Catchphrases: ${culturalMap.catchphrases.join(", ")}`);
  const nicheVocabBlock = cmBlocks.length
    ? `\nNICHE VISUAL VOCABULARY (the niche's OWN characters, gags, and visual concepts — USE THESE to give concepts a concrete visual subject, per STEP 4, not just text):\n${cmBlocks.map(b => `- ${b}`).join("\n")}\n`
    : "";
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
White Space Opportunities: ${niche ? JSON.stringify(niche.whiteSpace) : "No research available"}
${nicheVocabBlock}
STYLE RULE (MANDATORY): Never set a concept's "style" to anything cartoonish, clip-art, kawaii, chibi, or childish/exaggerated.${(allowedStyles && allowedStyles.length) ? ` Set each concept's "style" to the single best-matching option from this approved allowlist: ${allowedStyles.join(", ")}.` : ""}`;

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

  // Etsy validation — TOP WINNERS only (PO 2026-06-14). Previously hit the Etsy API for all ~30
  // concepts even though only the winners show market data on their report card — large waste, and
  // dozens of throttled calls were a major source of stage-5 latency / Etsy quota burn. The count
  // tracks pipelineConfig.winnersToGenerate so validation always matches the rendered winners.
  if (etsyApiKey) {
    const winnerCount = await resolveWinnerCount(runId);
    const fresh = await getConceptsByRunId(runId); // pick up the trendScore just written above
    const topWinners = [...fresh]
      .filter((c) => c.trendScore !== null && c.trendScore > 0)
      .sort((a, b) => (b.trendScore ?? 0) - (a.trendScore ?? 0))
      .slice(0, winnerCount);
    await runEtsyValidation(topWinners, etsyApiKey);
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
// Each winner's image prompt is written by the NICHE DESIGN COUNCIL (NICHE_COUNCIL_SYSTEM below):
// it vets the concept against the Niche Hunter's gate questions and decides which on-brand mascot
// is the hero (or type-only), then writes the prompt. Rendered text-to-image (scans-to-1).

/** Winner image generation (PO 2026-06-12: scan designs read "animated, terrible color and
 *  typography" because they used the Forge ImageService; the Niche Hunter's good designs use
 *  OpenAI gpt-image-2). Primary: gpt-image-2 (premium typography/realism). Fallback: Forge, so a
 *  transient gpt failure never ships 0 images (the earlier "why no images?" bug). One retry on the
 *  primary before falling back. */
const GPT_IMAGE_TIMEOUT_MS = 90_000; // gpt-image-2 "medium" upper bound; fail fast to the fallback
// BOUNDED per-image time (PO 2026-06-12 — run #720001 timed out at stage 6 when a stacked
// edit→edit-retry→gpt-text→Forge chain ran ~400s/image). Now exactly ONE gpt-image-2 attempt
// (edit if a bestseller image is present, else text-to-image) → Forge fallback. Worst case
// ~90s + 60s; Forge guarantees we never ship 0 images.
/** Map the council's chosen design aspect to (a) a native gpt-image-2 canvas size and (b) a short
 *  prompt prefix telling the model to draw the design only in the requested aspect region. The
 *  generations endpoint REJECTS background:"transparent" (see imageGeneration.ts:63-65, removed
 *  2026-06-13), so the output is always opaque and Kontext (productionImageProcessor v3) strips
 *  the background on-demand at mockup time. cropToContent then trims to the actual content bbox. */
function aspectToGenSize(aspect: "1:1" | "4:5" | "5:4" | "9:16" | "16:9"): "1024x1024" | "1024x1536" | "1536x1024" {
  if (aspect === "1:1") return "1024x1024";
  if (aspect === "4:5" || aspect === "9:16") return "1024x1536"; // portrait canvases
  return "1536x1024"; // 5:4, 16:9 → landscape canvas
}
function aspectGuidanceForPrompt(aspect: "1:1" | "4:5" | "5:4" | "9:16" | "16:9"): string {
  if (aspect === "1:1") return ""; // no extra steering needed for square
  const shape = aspect === "4:5" || aspect === "9:16" ? "PORTRAIT (tall)" : "LANDSCAPE (wide)";
  // No "transparent margins" lie — gpt-image-2 can't deliver alpha. We tell the model to keep the
  // artwork compact inside the aspect region; Kontext + cropToContent handle the rest downstream.
  return `Compose the design in a ${aspect} ${shape} content area. Draw the artwork ONLY inside that ${aspect} region — do NOT stretch, fill, or extend it across the whole canvas. The final cropped output should genuinely read as ${aspect}.\n\n`;
}

async function generateImageWithRetry(
  prompt: string,
  label: string,
  sourceImageUrl?: string | null, // hybrid: when the winner's signal carries a real bestseller image,
                                  // EDIT it (NH mechanism) instead of text-to-image
  timeoutMultiplier = 1, // the serial retry pass passes >1 so genuinely-slow renders (heavy lane styles) get room
  aspect: "1:1" | "4:5" | "5:4" | "9:16" | "16:9" = "1:1", // PO 2026-06-16: per-concept design aspect
): Promise<{ url?: string | null }> {
  const useEdit = !!sourceImageUrl && /^https?:\/\//.test(sourceImageUrl);
  // In edit mode, anchor on the bestseller's print realism but output a NEW flat design — the NH's
  // trick ("output the design only, on white, not on a shirt") also handles listing photos that
  // show the shirt on a model.
  const editPrompt = `Use this reference image ONLY for its print quality, screen-print texture, color treatment and professional finish. Create a NEW, different design: ${prompt} Output the finished artwork as a standalone graphic — no shirt, no garment, no model, no mockup, no scene.`;
  // Aspect guidance is prepended to the prompt (no-op for 1:1) and the canvas is chosen to natively
  // support the requested aspect. cropToContent later trims to the content bbox; Kontext (v3
  // productionImageProcessor) handles bg-removal on-demand at mockup time.
  const aspectPrefix = aspectGuidanceForPrompt(aspect);
  const genSize = aspectToGenSize(aspect);
  const promptWithAspect = aspectPrefix + prompt;
  // ONE retry, ONLY on a RATE LIMIT (429), with an 8s backoff — run #840001 rendered just 1/5 winners,
  // the classic concurrent-429 signature (5/5 in an isolated burst). Any other error falls straight
  // through to Forge (bounded). Forge guarantees we never ship 0 images. Time-bounded for the cap.
  let lastGptError = "unknown";
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const gen = useEdit
        ? generateGptImage2Edit(aspectPrefix + editPrompt, sourceImageUrl!)
        : generateGptImage2(promptWithAspect, undefined, genSize);
      return await withTimeout(gen, GPT_IMAGE_TIMEOUT_MS * timeoutMultiplier, `${label} [gpt-image-2${useEdit ? " edit" : ""} #${attempt}]`);
    } catch (err) {
      lastGptError = err instanceof Error ? err.message : String(err);
      const rateLimited = /\b429\b|rate.?limit|too many requests/i.test(lastGptError);
      console.warn(`[Pipeline] ${label} gpt-image-2 attempt ${attempt} failed${rateLimited ? " (rate-limited)" : ""}: ${lastGptError.slice(0, 160)}`);
      if (rateLimited && attempt < 2) { await new Promise((r) => setTimeout(r, 8000)); continue; }
      break;
    }
  }
  console.warn(`[Pipeline] ${label} falling back to Forge ImageService`);
  try {
    return await withTimeout(generateImage({ prompt }), IMAGE_GEN_TIMEOUT_MS * timeoutMultiplier, `${label} [forge fallback]`);
  } catch (forgeErr) {
    // TEMP (2026-06-13): surface BOTH failures so stage 6 can persist why an image was lost.
    const fmsg = forgeErr instanceof Error ? forgeErr.message : String(forgeErr);
    throw new Error(`gpt[${lastGptError.slice(0, 130)}] forge[${fmsg.slice(0, 130)}]`);
  }
}

/** The niche DESIGN COUNCIL (PO 2026-06-13): the trained brain that vets each NEW concept against the
 *  Niche Hunter's gate questions, then — only if it passes — writes the image prompt, DECIDING per
 *  concept which on-brand MASCOT is the hero (vs a generic racket/player) or whether type-only is
 *  stronger. This is what makes designs feature recognizable characters instead of stock imagery. */
const NICHE_COUNCIL_SYSTEM = `You are the design council for a print-on-demand niche — a seasoned designer who knows this niche's audience and its on-brand characters intimately. For ONE new concept idea you FIRST vet it with the gate questions, THEN — only if it passes — write a single image-generation prompt. You decide, like the Niche Hunter's council does, whether this is a MASCOT design or a clean TYPE-ONLY design.

You are given a NICHE KNOWLEDGE BASE. Its ON-BRAND MASCOTS are the ONLY recognizable hero characters you may use. A generic racket, paddle, ball, court, or anonymous player is NOT a hero — it reads as stock clip-art and does not sell. The recognizable mascot (e.g. a shaggy llama in sunglasses dinking) IS what makes the design convert.

STEP 1 — VET (answer honestly):
1. canWork — can this become a genuinely sellable design for this niche?
2. hero — WHICH single named MASCOT from the knowledge base is the hero (doing a real niche action/pose), OR "TYPE-ONLY" when the typography itself is the strong idea and a character would only clutter it. NEVER answer with a generic racket / ball / court / anonymous player.
3. style — use the ASSIGNED STYLE LANE given in the user message. Each winning design is deliberately assigned ONE approved style so the batch of winners spans a RANGE of styles (and palettes) instead of all looking alike. Render in that assigned style. Only pick a DIFFERENT approved style if the assigned one genuinely cannot carry THIS specific concept — and if you deviate, choose another distinct approved style, never default back to a dark distressed look. The approved-reference IMAGES define the CRAFT and QUALITY BAR and the niche's character treatment, NOT a single look to clone.
4. needsText — does it need the headline/pun to read as this niche, or does the mascot carry it alone?
5. viral — would a fan stop scrolling and BUY this? "high" | "med" | "low".
6. aspect — what CANVAS SHAPE best serves THIS specific design? "1:1" (square — logos, badges, centered crests, balanced compositions), "4:5" (portrait — most apparel: a tall mascot in a pose, hero standing/leaping, vertical composition), "5:4" (slight landscape — most apparel banners, wider mascot in action), "9:16" (tall portrait — long banners, narrow stacked typography, mug wraps), "16:9" (wide — long puns, side-by-side gags, panoramic banners). Pick based on what this design WANTS to be — a leaping llama wants 4:5, a long phrase pun wants 16:9, a tight badge wants 1:1.

STEP 2 — Only if canWork is true AND viral is "high" or "med", write "prompt":
- MASCOT hero → feature that SPECIFIC mascot performing a real niche action with ACCURATE niche equipment (pickleball: a SOLID RECTANGULAR paddle, a PERFORATED HOLLOW ball, the kitchen line). The mascot is the focal graphic; the headline sits with it. Add the pun/headline text only if needsText.
- TYPE-ONLY → a bold, characterful typographic treatment of the headline; no forced graphic.
- Render the design in the EXACT chosen style — match its layout, line-work, palette and typography from the playbook. Do NOT mix styles (a Bold Typographic must not be a circular badge; a Vintage/Distressed must not have a clean modern sans-serif).
- Isolated design, headline spelled VERBATIM. ACCURATE niche equipment.
- ABSOLUTE QUALITY BAR — every style: premium, sellable-on-Etsy commercial quality; NEVER cartoonish, kawaii, chibi, Pixar/Disney, childish, clip-art, sticker, 3D-render, or flat clean modern mascot-logo. If a knowledge-base note calls a mascot "cute"/"comical"/"happy"/"zen", render the animal with characterful craftsmanship appropriate to the chosen style — never as a cartoon.
- PRINT-SAFE (DTF) — every element must survive direct-to-film print and a magenta chroma-key. APPLIES TO EVERY ELEMENT regardless of which style you picked: typography, mascot, illustration, paddles, accents, decorations — ALL of them. Render nets, mesh, fences, grids, screens, lattices, halftone fills, ropes, chains and any repeating-line motif as SOLID FULL-COLOR shapes, NEVER as thin open mesh with see-through gaps. No hairline or single-pixel strokes; every line, outline and stem must be a thick, confidently weighted shape. NEVER prescribe a "line art", "thin line", "minimalist line", "fine line", "single line", "hairline", "delicate line", or "outlined" treatment for ANY element in the prompt — every illustration (paddle, mascot, prop, accessory) must be a fully-rendered FILLED shape (solid silhouette or thickly-outlined block), not a wireframe drawing. PROHIBITED decorative motifs that won't survive DTF: tiny stars, sparkles, dust specks, sweat drops, dotted accent marks, fine flourishes, scattered confetti dots — anything under ~30px stroke weight. Avoid tiny unreadable text and fine smooth gradients, and keep the artwork's palette clearly away from magenta / hot-pink / fuchsia (the background key color) so nothing keys out.
- ASPECT: compose the design to FIT THE CHOSEN ASPECT inside the canvas. For non-square aspects (4:5, 5:4, 9:16, 16:9), draw the design only inside that aspect's content area — never stretch elements to fill a canvas that doesn't match the aspect. Downstream bg-removal (Kontext) handles the rest.
- COMPOSITION (DTF cost + multi-color shirts): default to a COMPACT design — the subject (mascot, typography, or mascot+headline) standing ALONE in the canvas with no enclosing sunburst/sunset/halftone-gradient/rectangular panel, no retro frame, no full-canvas backdrop. The ONLY exception is when the concept IS a badge, crest, seal, or varsity emblem (e.g. Collegiate/Varsity, a country-club crest): then the full design fills the badge SHAPE. A compact subject is easier for downstream bg-removal to isolate cleanly, reads on any shirt color, and uses less DTF ink.
- If it fails the gate (canWork false or viral low), set "prompt" to "".

═══ STYLE PLAYBOOK — what each style looks like (use the one you chose; do not mix) ═══
${Object.entries(STYLE_PLAYBOOK).map(([name, desc]) => `- ${name}: ${desc}`).join("\n")}

Return STRICT JSON: {"canWork": boolean, "hero": "mascot name or TYPE-ONLY", "style": "EXACTLY one style name from the approved menu", "needsText": boolean, "viral": "high|med|low", "aspect": "1:1|4:5|5:4|9:16|16:9", "prompt": "string"}.`;

/** An edit-mode rendering anchor drawn from the workspace's Niche Hunter library. */
export type NicheAnchor = { image: string; status: string; score: number; text: string };

const ANCHOR_STOP = new Set(["the", "and", "for", "with", "shirt", "tshirt", "tee", "design", "gift", "funny", "cute"]);
const anchorTokens = (s: string) => new Set((s || "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !ANCHOR_STOP.has(w)));

/** Pick the best edit anchor for a concept (audit #9 — extracted pure for unit testing):
 *  thematic token-overlap match wins; with no overlap, rotate the approved-first/score-sorted pool
 *  by index so the run's winners don't all collapse onto one design. Returns null for an empty pool. */
export function selectAnchorImage(pool: NicheAnchor[], conceptText: string, idx: number): string | null {
  if (!pool.length) return null;
  const ct = anchorTokens(conceptText);
  let best: NicheAnchor | null = null, bestOverlap = 0;
  for (const a of pool) {
    const at = anchorTokens(a.text);
    let overlap = 0; ct.forEach((t) => { if (at.has(t)) overlap++; });
    if (overlap > bestOverlap) { bestOverlap = overlap; best = a; }
  }
  if (best && bestOverlap > 0) return best.image;
  const byPref = [...pool].sort((a, b) => (b.status === "approved" ? 1 : 0) - (a.status === "approved" ? 1 : 0) || b.score - a.score);
  return byPref[idx % byPref.length].image;
}

// ─── Council context + single-shot runner (shared by stageDesignExpansion + regenerateConceptViaCouncil) ───
// Phase 2 extraction (PO 2026-06-16, plan wpekckq15): the scan pipeline and per-concept regen now share
// the SAME context-loading + council-call logic. Mode is selected by opts.{lockedStyle | assignedStyle}.

export type WorkspaceCouncilContext = {
  nicheKB: string;
  avoidDirectives: string;
  allowedStylesList: string[];
  approvedVisionRefs: Array<{ url: string; title: string }>;
};

const EMPTY_COUNCIL_CONTEXT: WorkspaceCouncilContext = {
  nicheKB: "", avoidDirectives: "", allowedStylesList: [], approvedVisionRefs: [],
};

const COUNCIL_TAG_DIRECTIVE: Record<string, string> = {
  poor_composition: "a strong, balanced composition",
  off_brand: "stay strictly on-brand for this niche",
  transfer_failed: "an idea native to THIS niche (no awkward cross-niche transfer)",
  bad_subject: "a clear, appealing focal subject",
  weak_humor: "genuinely sharp, funny writing",
  bad_colors: "a deliberate, harmonious limited palette",
  too_generic: "a distinctive, non-generic idea",
  wrong_style: "the niche's proven art style",
  too_dark: "varied, lighter palettes — do NOT default every design to a dark background",
  too_similar: "a look clearly distinct from the rest of the set (different style + palette)",
};

const COUNCIL_NON_PRINTABLE_STYLES = new Set(["Photorealistic", "Minimalist Line-Art", "Vintage Engraving"]);

/**
 * Load the workspace-level council context (vision refs + niche KB + avoid directives + allowed styles).
 * Returns an empty context for a null workspaceId or any DB/HEAD failure — both call sites then proceed
 * with the system prompt + playbook + concept text alone (no 500s, scan parity preserved).
 */
export async function loadCouncilContext(
  workspaceId: string | null,
): Promise<WorkspaceCouncilContext> {
  if (!workspaceId) return { ...EMPTY_COUNCIL_CONTEXT };
  try {
    const { getWorkspaceById } = await import("./workspaceDb");
    const { getDismissedRevisionTagsByWorkspace } = await import("./db");
    const { DEFAULT_ALLOWED_STYLES } = await import("../shared/styleProfile");
    const [wsRow, all] = await Promise.all([
      getWorkspaceById(workspaceId),
      getTrendPatternsByWorkspace(workspaceId),
    ]);
    const approved = all.filter((p) => p.status === "approved");
    const dismissed = all.filter((p) => p.status === "dismissed");
    // (1) VISION REFERENCES — approved-only, most-recent first, HEAD-validated, top 6.
    let approvedVisionRefs: Array<{ url: string; title: string }> = approved
      .filter((p) =>
        (p.productionDesignUrl && /^https?:\/\//.test(p.productionDesignUrl)) ||
        (p.sourceImageUrl && /^https?:\/\//.test(p.sourceImageUrl)))
      .sort((a, b) => (b.approvedAt?.getTime() ?? b.createdAt?.getTime() ?? 0) - (a.approvedAt?.getTime() ?? a.createdAt?.getTime() ?? 0))
      .slice(0, 6)
      .map((p) => ({
        url: (p.productionDesignUrl && /^https?:\/\//.test(p.productionDesignUrl) ? p.productionDesignUrl : p.sourceImageUrl) as string,
        title: p.patternName ?? "Untitled",
      }));
    if (approvedVisionRefs.length) {
      const checked = await Promise.all(approvedVisionRefs.map(async (r) => {
        try {
          const resp = await withTimeout(fetch(r.url, { method: "HEAD" }), 8000, `ref check ${r.title}`);
          return resp.ok && (resp.headers.get("content-type") ?? "").startsWith("image/") ? r : null;
        } catch { return null; }
      }));
      const live2 = checked.filter((r): r is { url: string; title: string } => !!r);
      if (live2.length !== approvedVisionRefs.length) {
        console.warn(`[Council/Context] Vision refs: ${approvedVisionRefs.length - live2.length} dead URL(s) dropped, ${live2.length} usable`);
      }
      approvedVisionRefs = live2;
    }
    // (2) AVOID — patterns + scan-design dismissals + per-version revision dismissals (full NH parity).
    const tagCounts: Record<string, number> = {};
    for (const p of dismissed) for (const t of ((p.rejectionTags as string[]) ?? [])) tagCounts[t] = (tagCounts[t] ?? 0) + 1;
    for (const t of await getDismissedConceptTagsByWorkspace(workspaceId)) tagCounts[t] = (tagCounts[t] ?? 0) + 1;
    for (const t of await getDismissedRevisionTagsByWorkspace(workspaceId)) tagCounts[t] = (tagCounts[t] ?? 0) + 1;
    const topTags = Object.entries(tagCounts).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([t]) => COUNCIL_TAG_DIRECTIVE[t]).filter(Boolean);
    const avoidDirectives = topTags.length ? topTags.join("; ") : "";
    // (3) NICHE KB — mascots / gags / catchphrases / transferable concepts.
    const cm = ((wsRow?.nicheProfile ?? {}) as { culturalMap?: Record<string, any> }).culturalMap ?? {};
    const kb: string[] = [];
    const mascots = (cm.animalMascots ?? []).filter((m: any) => m?.animal).map((m: any) => `${m.animal}${m.visualTreatment ? ` (${m.visualTreatment})` : ""}`);
    if (mascots.length) kb.push(`ON-BRAND MASCOTS — the ONLY recognizable hero characters: ${mascots.join("; ")}`);
    const gags = (cm.funPoints ?? []).map((f: any) => f?.visualConcept).filter(Boolean);
    if (gags.length) kb.push(`Signature visual gags: ${gags.slice(0, 6).join(" | ")}`);
    const phrases = (cm.catchphrases ?? []).filter(Boolean);
    if (phrases.length) kb.push(`Catchphrases: ${phrases.slice(0, 8).join(", ")}`);
    const transfer = (cm.transferableVisualConcepts ?? []).map((t: any) => t?.targetAdaptation).filter(Boolean);
    if (transfer.length) kb.push(`Transferable concepts: ${transfer.slice(0, 5).join("; ")}`);
    const nicheKB = kb.join("\n");
    // (4) STYLE MENU — workspace allowlist minus non-printable styles.
    const wsStyles = wsRow?.styleProfile?.allowedStyles;
    const allowedStylesList = (Array.isArray(wsStyles) && wsStyles.length ? wsStyles : DEFAULT_ALLOWED_STYLES)
      .filter((s): s is string => typeof s === "string" && s.trim().length > 0 && !COUNCIL_NON_PRINTABLE_STYLES.has(s));
    console.log(`[Council/Context] ws=${workspaceId}: ${all.length} patterns (${approved.length} approved, ${dismissed.length} dismissed) | mascots=${mascots.length} gags=${gags.length} phrases=${phrases.length} | styles=${allowedStylesList.length} | visionRefs=${approvedVisionRefs.length} | avoid=${avoidDirectives || "none"}`);
    return { nicheKB, avoidDirectives, allowedStylesList, approvedVisionRefs };
  } catch (e) {
    console.warn(`[Council/Context] niche library/KB sourcing unavailable for ws=${workspaceId} (non-fatal):`, e);
    return { ...EMPTY_COUNCIL_CONTEXT };
  }
}

type CouncilDesignAspect = "1:1" | "4:5" | "5:4" | "9:16" | "16:9";

export type CouncilPromptSet = {
  concept: import("../drizzle/schema").DesignConcept;
  promptA: string;
  promptB: string;
  promptC: string;
  sourceImageUrl?: string | null;
  aspect: CouncilDesignAspect;
};

export type RunCouncilOnceOpts = {
  /** Hard-lock the style (regen path). Mutually exclusive with assignedStyle. */
  lockedStyle?: string;
  /** Soft style lane (scan path). Council may switch if the lane truly cannot carry the concept. */
  assignedStyle?: string;
  /** Scan-only "#1 of 10" label. */
  batchPosition?: { idx: number; total: number };
  /** Scan-only style hint derived from book.worldBible + book.styleDirectives (already stripCartoon'd). */
  conceptStyleHint?: string;
  /** Log prefix. Default: [Pipeline/Council] when assignedStyle, [Regen/Council] when lockedStyle. */
  logPrefix?: string;
  /** Timeout label. Default derived from the same signal. */
  timeoutLabel?: string;
};

/**
 * Run the design council ONCE for a single concept. Returns null when the council vetoes or errors.
 * Vision-grounded with a text-only retry on vision failure (audit B2(b) trap).
 */
export async function runCouncilOnce(
  concept: import("../drizzle/schema").DesignConcept,
  ctx: WorkspaceCouncilContext,
  opts: RunCouncilOnceOpts,
): Promise<CouncilPromptSet | null> {
  const isLocked = typeof opts.lockedStyle === "string" && opts.lockedStyle.length > 0;
  const isAssigned = typeof opts.assignedStyle === "string" && opts.assignedStyle.length > 0;
  if (isLocked === isAssigned) {
    throw new Error(`runCouncilOnce: exactly one of {lockedStyle, assignedStyle} must be set (concept=${concept.id})`);
  }
  const styleName = (isLocked ? opts.lockedStyle : opts.assignedStyle) as string;
  const logPrefix = opts.logPrefix ?? (isLocked ? "[Regen/Council]" : "[Pipeline/Council]");
  const timeoutLabel = opts.timeoutLabel ?? (isLocked
    ? `Council regenerate for concept ${concept.id}`
    : `Design council for winner concept ${concept.id}`);
  const fallbackStyleMenu = "Vintage/Distressed | Bold Typographic | Halftone Screen-Print";
  const styleMenuStr = ctx.allowedStylesList.length ? ctx.allowedStylesList.join(" | ") : fallbackStyleMenu;

  const visionRefIntro = ctx.approvedVisionRefs.length
    ? (isLocked
      ? `Below are ${ctx.approvedVisionRefs.length} t-shirt designs the BUYER has explicitly APPROVED for this niche. Study their CRAFT: texture, line work, typography quality, niche-character treatment, and premium sellable mood. This is the QUALITY BAR and the niche authenticity your output must match. They are NOT a single look to clone — render in your LOCKED STYLE LANE (below). Match the craftsmanship; render in your locked style.`
      : `Below are ${ctx.approvedVisionRefs.length} t-shirt designs the BUYER has explicitly APPROVED for this niche. Study their CRAFT: texture, line work, typography quality, niche-character treatment, and premium sellable mood. This is the QUALITY BAR and the niche authenticity your output must match. They are NOT a single look to clone — this design uses its ASSIGNED STYLE LANE (below), and across the batch the winners deliberately span DIFFERENT approved styles so the collection has range in both style and palette. Match the craftsmanship; render in your assigned style.`)
    : (isLocked
      ? `No approved-design references for this niche yet — fall back to the STYLE PLAYBOOK and your locked style lane.`
      : `No approved-design references for this niche yet — fall back to the STYLE PLAYBOOK and your assigned style lane.`);

  const styleLaneBlock = isLocked
    ? `YOUR LOCKED STYLE LANE for this design: ${styleName}
The buyer EXPLICITLY chose this style from the dropdown — render in "${styleName}" and its native palette per the STYLE PLAYBOOK. Do NOT switch to a different approved style — this is a single-concept regenerate, not a council-assigned lane. Allowed styles (for reference only, do NOT override): ${styleMenuStr}`
    : `YOUR ASSIGNED STYLE LANE for this design${opts.batchPosition ? ` (#${opts.batchPosition.idx + 1} of ${opts.batchPosition.total})` : ""}: ${styleName}
Render THIS design in "${styleName}" and its native palette per the STYLE PLAYBOOK — do NOT force a dark background. Only switch to a different APPROVED style if "${styleName}" genuinely cannot carry this concept; if you do, pick a distinct approved style and never collapse back to a dark distressed look. Full approved menu (for that fallback only): ${styleMenuStr}`;

  const conceptHeader = isLocked ? "THE CONCEPT TO REGENERATE:" : "THE NEW CONCEPT:";
  const styleHintLine = !isLocked
    ? `\nStage-4 suggested style hint (a guess only — override if the references suggest better): ${opts.conceptStyleHint || "(none)"}`
    : "";

  const userContent: import("./_core/llm").MessageContent[] = [
    { type: "text", text: `${visionRefIntro}\n\nAPPROVED REFERENCES (in order):${ctx.approvedVisionRefs.map((r, i) => `\n  ${i + 1}. "${r.title}"`).join("")}` },
    ...ctx.approvedVisionRefs.map((r): import("./_core/llm").MessageContent => ({ type: "image_url" as const, image_url: { url: r.url, detail: "low" as const } })),
    { type: "text", text: `NICHE KNOWLEDGE BASE (your only character palette for mascot picks):
${ctx.nicheKB || "(no mascots configured — fall back to a strong type-only design)"}

${styleLaneBlock}

${ctx.avoidDirectives ? `AVOID (learned from the buyer's past rejections): ${ctx.avoidDirectives}\n\n` : ""}${conceptHeader}
Name: ${concept.conceptName}
Headline (render VERBATIM): ${concept.headline ?? "none"}
Subtext (verbatim): ${concept.subtext ?? "none"}
Fan phrase it's anchored to: ${concept.sourcePhrase ?? "not specified"}${styleHintLine}` },
  ];

  const runCouncil = async (parts: import("./_core/llm").MessageContent[]): Promise<string> => {
    const res = await withTimeout(
      invokeLLM({
        messages: [
          { role: "system", content: NICHE_COUNCIL_SYSTEM },
          { role: "user", content: parts },
        ],
        response_format: { type: "json_object" },
      }),
      75_000,
      timeoutLabel,
    );
    return typeof res.choices[0]?.message?.content === "string" ? res.choices[0].message.content : "";
  };

  try {
    let content: string;
    try {
      content = await runCouncil(userContent);
    } catch (visionErr) {
      if (ctx.approvedVisionRefs.length) {
        console.warn(`${logPrefix} Vision call failed for concept ${concept.id}, retrying text-only:`, visionErr instanceof Error ? visionErr.message : visionErr);
        content = await runCouncil(userContent.filter((c) => typeof c === "string" || c.type !== "image_url"));
      } else {
        throw visionErr;
      }
    }
    const stripped = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
    const jStart = stripped.indexOf("{"), jEnd = stripped.lastIndexOf("}");
    const jsonStr = jStart >= 0 && jEnd > jStart ? stripped.slice(jStart, jEnd + 1) : stripped;
    let verdict: { canWork?: boolean; hero?: string; style?: string; viral?: string; aspect?: string; prompt?: string };
    try {
      verdict = JSON.parse(jsonStr);
    } catch {
      console.warn(`${logPrefix} JSON parse failed for concept ${concept.id}: ${content.slice(0, 200)}`);
      return null;
    }
    const ALLOWED_ASPECTS: readonly CouncilDesignAspect[] = ["1:1", "4:5", "5:4", "9:16", "16:9"];
    const aspect: CouncilDesignAspect = (ALLOWED_ASPECTS as readonly string[]).includes(verdict.aspect ?? "")
      ? (verdict.aspect as CouncilDesignAspect) : "1:1";
    const lockedTag = isLocked ? ` (locked=${styleName})` : "";
    console.log(`${logPrefix} "${concept.conceptName}" → hero=${verdict.hero ?? "?"} style=${verdict.style ?? "?"}${lockedTag} aspect=${aspect} viral=${verdict.viral ?? "?"} canWork=${verdict.canWork}`);
    const prompt = (verdict.canWork && verdict.viral !== "low" && verdict.prompt) ? verdict.prompt : "";
    return { concept, promptA: prompt, promptB: "", promptC: "", sourceImageUrl: null, aspect };
  } catch (err) {
    console.warn(`${logPrefix} Design council failed for concept ${concept.id}:`, err);
    return null;
  }
}

async function stageDesignExpansion(runId: number, force = false): Promise<number> {
  const stageStart = Date.now();
  console.log(`[Pipeline/Stage6] START stageDesignExpansion for run ${runId}`);
  const concepts = await getConceptsByRunId(runId);
  console.log(`[Pipeline/Stage6] Fetched ${concepts.length} concepts from DB`);
  const winnerCount = await resolveWinnerCount(runId);
  console.log(`[Pipeline/Stage6] Rendering top ${winnerCount} winner(s) (pipelineConfig.winnersToGenerate)`);

  // ── Step 1: Rank ALL concepts globally by trendScore (descending) ────
  const ranked = [...concepts]
    .filter((c) => c.trendScore !== null && c.trendScore > 0)
    .sort((a, b) => (b.trendScore ?? 0) - (a.trendScore ?? 0));
  console.log(`[Pipeline/Stage6] ${ranked.length} concepts have trendScore > 0`);

  // Assign globalRank to every scored concept
  for (let i = 0; i < ranked.length; i++) {
    const isWinner = i < winnerCount;
    await updateConceptImages(ranked[i].id, {
      globalRank: i + 1,
      isWinner,
    });
  }

  // ── Step 2: Select the top winners for image generation ──────────────
  // Default: only winners that don't already have images (no accidental replacement).
  // force=true (PO 2026-06-12, "Regenerate All Images" button): regenerate every winner — safe now
  // because the prior design is snapshotted into generation history before the overwrite below.
  const allWinners = ranked.slice(0, winnerCount);
  // Dismissed designs (PO 2026-06-15 "Dismiss") drop out of (re)generation entirely.
  const winners = (force ? allWinners : allWinners.filter((c) => !c.imageUrlA)).filter((c) => !c.dismissedAt);

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

  // Hybrid (PO 2026-06-12): pool of REAL in-niche Etsy bestseller images captured at ingest. Used
  // as the print-quality ANCHOR for edit-mode rendering. The bestseller need NOT match a winner's
  // own signal — the edit prompt uses it only as a quality/texture reference and creates a NEW
  // design — so winners whose own signal is Reddit-sourced (no image) still get one from the pool.
  const allRunBooks = await getBooksByRunId(runId);
  const bestsellerPool = allRunBooks
    .map((b) => b.coverUrl)
    .filter((u): u is string => !!u && /^https?:\/\//.test(u));
  console.log(`[Pipeline/Stage6] Bestseller image pool: ${bestsellerPool.length} real in-niche images for edit-mode rendering`);

  // ── Step 3: ONE focused prompt per winner from LLM in parallel ──
  type DesignAspect = "1:1" | "4:5" | "5:4" | "9:16" | "16:9";
  type PromptSet = { concept: typeof winners[0]; promptA: string; promptB: string; promptC: string; sourceImageUrl?: string | null; aspect: DesignAspect };

  // Niche style DNA (PO 2026-06-12: "use the Signals from the NICHE hunter to influence here").
  // The Niche Hunter extracts SourceStyleJSON from REAL Etsy bestsellers — feed that proven style
  // language (technique, line weight, shading, texture, type style, era) into the image prompts
  // instead of trusting the concept's own style label (which sometimes says "Cartoonish").
  // Council context (vision refs + niche KB + avoid directives + allowed styles) comes from the shared
  // loader (Phase 2 refactor). anchorPool stays inline because it's only used by the edit-mode renderer
  // (selectAnchorImage), not by the council itself.
  const runRow = await getRunById(runId);
  const councilCtx = await loadCouncilContext(runRow?.workspaceId ?? null);
  let anchorPool: NicheAnchor[] = [];
  try {
    if (runRow?.workspaceId) {
      const all = await getTrendPatternsByWorkspace(runRow.workspaceId);
      const live = all.filter((p) => p.status !== "dismissed");
      anchorPool = live
        .map((p): NicheAnchor | null => {
          const img = (p.status === "approved" && p.productionDesignUrl && /^https?:\/\//.test(p.productionDesignUrl))
            ? p.productionDesignUrl
            : (p.sourceImageUrl && /^https?:\/\//.test(p.sourceImageUrl) ? p.sourceImageUrl : null);
          if (!img) return null;
          const subj = (p.sourceStyleJson as Record<string, unknown> | null)?.subject;
          return { image: img, status: p.status, score: p.score ?? 0, text: `${p.patternName ?? ""} ${typeof subj === "string" ? subj : ""}`.toLowerCase() };
        })
        .filter((a): a is NicheAnchor => !!a);
      console.log(`[Pipeline/Stage6] Anchor pool: ${anchorPool.length} edit anchors from ${all.length} patterns`);
    }
  } catch (e) {
    console.warn(`[Pipeline] anchor pool sourcing unavailable (non-fatal):`, e);
  }

  // The concept-generation stage sometimes labels styles "Cartoonish, slightly exaggerated" — the
  // PO explicitly rejects cartoonish output, so strip those words before they reach the image model.
  const stripCartoon = (s: string) =>
    s.replace(/cartoon\w*|kawaii|chibi|childish|playful-humorous|slightly exaggerated illustrations?|mascot-style/gi, "")
      .replace(/\s{2,}/g, " ").replace(/(?:,\s*){2,}/g, ", ").replace(/^[\s,./]+|[\s,./]+$/g, "");

  // PORTFOLIO VARIETY (PO 2026-06-15): the council styles each winner independently against the SAME
  // approved refs, so it converged on the buyer's modal look. Assign each winner a different APPROVED
  // style so the batch spans a range of styles AND palettes. Soft lane — runCouncilOnce may veto.
  const styleLanes = councilCtx.allowedStylesList.length
    ? councilCtx.allowedStylesList
    : ["Vintage/Distressed", "Bold Typographic", "Halftone Screen-Print"];

  const runCouncilForWinner = async (concept: typeof winners[0], idx: number): Promise<PromptSet | null> => {
    const book = concept.bookId ? bookMapForImages.get(concept.bookId) : null;
    const wb = book?.worldBible as { illustratorStyle?: string } | null | undefined;
    const styleDirectives = book?.styleDirectives as import("../shared/styleProfile").StyleProfile | null | undefined;
    // Stage-4 sometimes writes "Cartoonish, slightly exaggerated"; strip those words before sending.
    const conceptStyleHint = stripCartoon(
      styleDirectives
        ? `${styleDirectives.primaryAesthetic} (typography ${styleDirectives.typographyStyle})`
        : `${concept.style}. ${wb?.illustratorStyle ?? book?.typographyStyle ?? ""}`.trim()
    );
    return runCouncilOnce(concept, councilCtx, {
      assignedStyle: styleLanes[idx % styleLanes.length],
      batchPosition: { idx, total: winners.length },
      conceptStyleHint,
    });
  };

  // audit M1: throttle council calls to COUNCIL_CONCURRENCY — 5 concurrent 6-image vision calls means
  // ~30 simultaneous image fetches by the gateway; batch them like the image-gen loop.
  const COUNCIL_CONCURRENCY = 2;
  const promptResults: PromiseSettledResult<PromptSet | null>[] = [];
  for (let i = 0; i < winners.length; i += COUNCIL_CONCURRENCY) {
    const batch = winners.slice(i, i + COUNCIL_CONCURRENCY);
    promptResults.push(...(await Promise.allSettled(batch.map((c, j) => runCouncilForWinner(c, i + j)))));
  }
  const validPromptSets = promptResults
    .map((r) => (r.status === "fulfilled" ? r.value : null))
    .filter((r): r is PromptSet => r !== null && (r.promptA.length > 0 || r.promptB.length > 0 || r.promptC.length > 0));

  console.log(`[Pipeline] Got ${validPromptSets.length} valid prompt sets, generating ${validPromptSets.length} images (1 hero per concept) in parallel...`);

  // ── Step 4: Generate all images in parallel (up to 15) ───────────────
  type ImageTask = { concept: typeof winners[0]; variation: "A" | "B" | "C"; prompt: string; sourceImageUrl?: string | null; aspect: DesignAspect };
  const allImageTasks: ImageTask[] = [];

  for (const ps of validPromptSets) {
    // scans-to-1 (PO 2026-06-11): render ONE hero image per concept (was 3) — cuts scan image-gen
    // cost 3x. Prefer variation A (Clean/Bold hero); fall back to B/C only if A came back empty.
    const heroPrompt = ps.promptA || ps.promptB || ps.promptC;
    if (heroPrompt) allImageTasks.push({ concept: ps.concept, variation: "A", prompt: heroPrompt, sourceImageUrl: ps.sourceImageUrl, aspect: ps.aspect });
  }

  const runImageTask = async (task: typeof allImageTasks[number], timeoutMultiplier = 1) => {
    try {
      const img = await generateImageWithRetry(
        task.prompt,
        `Image ${task.variation} for concept ${task.concept.id}`,
        task.sourceImageUrl,
        timeoutMultiplier,
        task.aspect,
      );
      const rawUrl = img.url ?? null;
      // Production-ready transparent PNG (background removal) is DEFERRED out of the scan (PO
      // 2026-06-13): it fired a SECOND gpt-image-2 call + heavy sharp work per image, doubling the
      // stage-6 load that was failing 4/5 renders. The first-gen is transparent already; the
      // on-demand "Process Images" path (processProductionImages) creates productionUrl* when needed.
      return { ...task, imageUrl: rawUrl, error: null };
    } catch (err) {
      console.warn(`[Pipeline] Image ${task.variation} failed for concept ${task.concept.id}:`, err);
      return { ...task, imageUrl: null, error: err };
    }
  };

  // Throttle to IMG_CONCURRENCY at a time (PO 2026-06-13) — firing all 5 gpt-image-2 calls at once
  // rate-limited 4/5 on run #840001 (5/5 in an isolated burst). Small batches stay under the image
  // API's concurrency limit; combined with the 429-backoff retry in generateImageWithRetry.
  const IMG_CONCURRENCY = 2;
  const imageResults: PromiseSettledResult<Awaited<ReturnType<typeof runImageTask>>>[] = [];
  for (let i = 0; i < allImageTasks.length; i += IMG_CONCURRENCY) {
    const batch = allImageTasks.slice(i, i + IMG_CONCURRENCY);
    imageResults.push(...(await Promise.allSettled(batch.map((c) => runImageTask(c)))));
  }

  // Normalize (runImageTask always resolves with {imageUrl, error} — it catches internally).
  const results = imageResults
    .map((r) => (r.status === "fulfilled" ? r.value : null))
    .filter((v): v is NonNullable<typeof v> => !!v);

  // Self-healing retry (PO 2026-06-15): under load a few renders double-time-out (gpt-image-2 90s +
  // Forge 60s). Retry the failures ONCE, serially (concurrency 1), to give the slow API room — turns a
  // transient 3/10 into ~10/10 instead of permanently dropping those designs. A still-failed image keeps
  // its prior design (immutability guard below); a partial run is NEVER a whole-run failure.
  const failed = results.filter((res) => !res.imageUrl);
  if (failed.length) {
    console.warn(`[Pipeline/Stage6] ${failed.length}/${allImageTasks.length} image(s) failed first pass — retrying serially with an extended timeout`);
    for (const res of failed) {
      const retry = await runImageTask(res, 1.6); // 1.6× budget (gpt ~144s, forge ~96s) — heavy lane renders just need more time
      if (retry.imageUrl) { res.imageUrl = retry.imageUrl; res.prompt = retry.prompt; res.error = null; }
    }
    const stillFailed = results.filter((res) => !res.imageUrl).length;
    if (stillFailed) console.warn(`[Pipeline/Stage6] ${stillFailed}/${allImageTasks.length} still failed after retry — keeping the prior design for those`);
  }

  // ── Step 5: Group results by concept and save to DB ──────────────────
  const conceptImageMap = new Map<number, { promptA?: string; promptB?: string; promptC?: string; urlA?: string | null; urlB?: string | null; urlC?: string | null }>();

  let imagesGenerated = 0;

  for (const { concept, variation, prompt, imageUrl } of results) {
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
  const priorById = new Map(ranked.map((c) => [c.id, c]));
  for (const [conceptId, imgs] of Array.from(conceptImageMap)) {
    // Keep full generation history (PO directive): snapshot the design being replaced BEFORE the
    // overwrite — same rule as concepts.regenerateImage, now also on bulk/forced regeneration.
    const prior = priorById.get(conceptId);
    if (imgs.urlA && prior?.imageUrlA && prior.imageUrlA !== imgs.urlA) {
      try { await snapshotGenerationToHistory(conceptId, prior.imageUrlA, prior.style); }
      catch (e) { console.warn(`[Pipeline] history snapshot failed for concept ${conceptId} (non-fatal):`, e); }
    }
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

      // Phase B (PO 2026-06-09): the concept council picks each concept's style from a curated
      // allowlist (never cartoonish). Default to DEFAULT_ALLOWED_STYLES so it applies to ALL runs
      // (incl. existing workspaces); a workspace's own styleProfile.allowedStyles overrides.
      // Non-fatal on failure (stageGenerate still enforces never-cartoonish unconditionally).
      let allowedStyles: string[] | undefined;
      try {
        const { DEFAULT_ALLOWED_STYLES } = await import("../shared/styleProfile");
        allowedStyles = DEFAULT_ALLOWED_STYLES;
        if (workspaceId) {
          const { getWorkspaceById } = await import("./workspaceDb");
          const ws = await getWorkspaceById(workspaceId);
          const a = ws?.styleProfile?.allowedStyles;
          if (Array.isArray(a) && a.length > 0) allowedStyles = a;
        }
      } catch (e) {
        console.warn("[Pipeline/Stage4] allowedStyles load failed (non-fatal):", e);
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
          forumSignalsMap,
          allowedStyles,
          nicheProfile?.culturalMap
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

  // Wrap with overall timeout — scaled to the winner count (more winners = more render time).
  const overallTimeoutMs = pipelineTimeoutForWinners(await resolveWinnerCount(runId));
  try {
    return await withTimeout(
      pipelinePromise,
      overallTimeoutMs,
      "Overall pipeline execution"
    );
  } catch (err: any) {
    // If the pipeline timed out, mark it as failed
    const errorMsg = err?.message ?? String(err);
    if (errorMsg.includes("Timeout")) {
      try {
        await failRun(runId, `Pipeline timed out after ${overallTimeoutMs / 1000}s: ${errorMsg}`);
        await notifyOwner({
          title: `Design Bot Run #${runId} Timed Out`,
          content: `Pipeline run #${runId} exceeded the ${overallTimeoutMs / 1000}s time limit and was automatically stopped.\n\nError: ${errorMsg}`,
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
          forumSignalsMap,
          undefined,
          resumeNicheProfile?.culturalMap
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
 * Per-concept regenerate that ROUTES THROUGH THE SAME DESIGN COUNCIL as the scan pipeline (PO
 * 2026-06-16). The old concepts.regenerateImage in routers.ts was a stripped-down LLM prompt-writer
 * with no niche KB, no vision references, no avoid directives, no aspect picker — producing
 * visibly thinner designs than scan winners. This orchestrator gives single-concept regenerate the
 * SAME context the pipeline council has: workspace mascots/catchphrases, approved-design vision
 * references, dismiss-tag avoid directives, the allowed-styles menu, the STYLE PLAYBOOK, and the
 * council's aspect picker — with the user's dropdown style LOCKED as the assigned lane.
 *
 * Returns { success, message, imageUrl?, style? }. Snapshots the prior design to generation
 * history; updates concept.imageUrlA + imagePromptA + style; clears productionUrlA so mockups
 * re-process. Phase 1: duplicates context-loading from stageDesignExpansion — Phase 2 will extract
 * a shared helper. This commit keeps the pipeline path UNTOUCHED to avoid regression risk.
 */
export async function regenerateConceptViaCouncil(
  conceptId: number,
  lockedStyle: string,
): Promise<{ success: boolean; message: string; imageUrl?: string; style?: string }> {
  const concept = await getConceptById(conceptId);
  if (!concept) return { success: false, message: "Concept not found." };
  const run = await getRunById(concept.runId);
  const workspaceId = run?.workspaceId ?? null;

  // Load workspace context (vision refs + niche KB + avoid + allowed styles) + run the council ONCE,
  // locked to the buyer-chosen style. Both helpers shared with stageDesignExpansion (Phase 2).
  const councilCtx = await loadCouncilContext(workspaceId);
  const promptSet = await runCouncilOnce(concept, councilCtx, { lockedStyle });
  if (!promptSet) {
    return { success: false, message: "Council failed or returned malformed JSON — see server logs." };
  }
  const promptText = promptSet.promptA;
  if (!promptText) {
    return { success: false, message: "Council vetoed the concept (canWork=false or viral=low) — no prompt to render." };
  }
  const aspect = promptSet.aspect;

  // ── Snapshot prior design + render + save ─────────────────────────────────────────────────────
  try {
    await snapshotGenerationToHistory(conceptId, concept.imageUrlA, concept.style);
  } catch (e) {
    console.warn(`[Regen/Council] history snapshot failed for concept ${conceptId} (non-fatal):`, e);
  }
  const img = await generateImageWithRetry(promptText, `Regenerate concept ${conceptId}`, null, 1, aspect);
  if (!img.url) {
    return { success: false, message: "Image generation returned no URL." };
  }
  await updateConceptImages(conceptId, { imageUrlA: img.url, imagePromptA: promptText });
  await updateConceptStyle(conceptId, lockedStyle);
  await updateConceptProductionUrl(conceptId, "A", null);

  return { success: true, message: `Regenerated in "${lockedStyle}" via the design council.`, imageUrl: img.url, style: lockedStyle };
}

/**
 * First-time image generation for a concept that currently has NO images. Routes through the same
 * council as the scan pipeline and regenerate — closes the last quality gap (PO 2026-06-17: a fresh
 * generation of "DUPR Driven" came back as bare typography + paddle/arrow accents because the legacy
 * generateSingleImage in routers.ts was the 2-step prompt-writer with stale concept.style + no
 * playbook / no DTF rules / no Bold Typographic enforcement / no niche KB / no vision refs / no
 * aspect). Uses ASSIGNED-style mode (soft lane) — the council may veto the concept's scan-time style
 * if the workspace's allowed-styles menu doesn't include it (e.g. "athletic, data-driven" → council
 * picks a real playbook style instead).
 */
export async function generateConceptViaCouncil(
  conceptId: number,
): Promise<{ success: boolean; message: string; imageUrl?: string; style?: string }> {
  const concept = await getConceptById(conceptId);
  if (!concept) return { success: false, message: "Concept not found." };
  if (concept.imageUrlA || concept.imageUrlB || concept.imageUrlC) {
    return { success: false, message: "Concept already has images." };
  }
  const run = await getRunById(concept.runId);
  const workspaceId = run?.workspaceId ?? null;
  const councilCtx = await loadCouncilContext(workspaceId);

  // Pick an assigned style. The concept's scan-time `style` (often a Stage-4 phrase like
  // "athletic, data-driven") is rarely a valid playbook style — use it ONLY when it matches the
  // allowed-styles menu; otherwise fall back to the first allowed style and let the council veto.
  const fallbackLane = ["Vintage/Distressed", "Bold Typographic", "Halftone Screen-Print"];
  const allowed = councilCtx.allowedStylesList.length ? councilCtx.allowedStylesList : fallbackLane;
  const conceptStyleIsValid = typeof concept.style === "string" && allowed.includes(concept.style);
  const assignedStyle = conceptStyleIsValid ? concept.style : allowed[0];

  const promptSet = await runCouncilOnce(concept, councilCtx, {
    assignedStyle,
    conceptStyleHint: concept.style ?? "",
  });
  if (!promptSet) return { success: false, message: "Council failed or returned malformed JSON — see server logs." };
  const promptText = promptSet.promptA;
  if (!promptText) {
    return { success: false, message: "Council vetoed the concept (canWork=false or viral=low) — no prompt to render." };
  }
  const aspect = promptSet.aspect;
  const finalStyle = assignedStyle;

  const img = await generateImageWithRetry(promptText, `Generate concept ${conceptId}`, null, 1, aspect);
  if (!img.url) return { success: false, message: "Image generation returned no URL." };
  await updateConceptImages(conceptId, { imageUrlA: img.url, imagePromptA: promptText });
  await updateConceptStyle(conceptId, finalStyle);
  await updateConceptProductionUrl(conceptId, "A", null);
  return { success: true, message: `Generated 1 design via the design council.`, imageUrl: img.url, style: finalStyle };
}

/**
 * Regenerate images for the top winner concepts in a completed run.
 * Used when a run completed with 0 images (e.g., due to timeout during Stage 6).
 * Also re-runs scoring (Stage 5) if all concepts have NULL trendScore (scoring timed out).
 * Safe to call multiple times — only regenerates concepts with null imageUrlA.
 */
export async function regenerateImagesForRun(runId: number, force = false): Promise<number> {
  console.log(`[Pipeline] Regenerating images for run #${runId}${force ? " (FORCE — all winners)" : ""}...`);
  // Clear any stale errorLog from a prior (pre-fix) failed regen so it can't linger as a false "RUN FAILED".
  await clearRunErrorAndComplete(runId);

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

  const count = await stageDesignExpansion(runId, force);
  await updateRunImagesGenerated(runId, count);
  console.log(`[Pipeline] Image regeneration complete: ${count} images for run #${runId}`);
  return count;
}
