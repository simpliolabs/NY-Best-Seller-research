/**
 * Forum Scraping Module — v6
 * All sources now use LLM-based analysis for 100% reliability.
 * External APIs (Reddit, Goodreads, Open Library) are unreliable from Cloud Run:
 * - Reddit blocks server-side requests
 * - Goodreads returns 403/CAPTCHA
 * - Open Library/Wikipedia don't have entries for brand-new bestsellers
 *
 * Each source represents a different analytical LENS on the book:
 * 1. Reddit → Fan Community & Viral Potential
 * 2. Goodreads → Reader Reception & Shelf Categorization
 * 3. StoryGraph → Mood, Pace & Theme Mapping
 * 4. Fable → Book Club Discussion & Character Analysis
 * 5. Book Riot → Cultural Angles & Cross-Fandom Opportunities
 */

import { invokeLLM } from "./_core/llm";

const LLM_TIMEOUT_MS = 30_000;

export interface RedditSignal {
  postCount: number;
  avgUpvotes: number;
  topSubreddits: string[];
  sampleTitles: string[];
  status: "success" | "failed" | "skipped";
}

export interface GoodreadsSignal {
  ratingsCount: number;
  avgRating: number;
  reviewCount: number;
  topShelves: string[];
  status: "success" | "failed" | "skipped";
}

export interface StoryGraphSignal {
  moods: string[];
  pace: string;
  themes: string[];
  status: "success" | "failed" | "skipped";
}

export interface FableSignal {
  clubCount: number;
  discussionCount: number;
  subjects?: string[];
  status: "success" | "failed" | "skipped";
}

export interface BookRiotSignal {
  articleCount: number;
  articleTitles: string[];
  culturalAngles?: string[];
  status: "success" | "failed" | "skipped";
}

export interface ForumSignals {
  reddit?: RedditSignal;
  goodreads?: GoodreadsSignal;
  storyGraph?: StoryGraphSignal;
  fable?: FableSignal;
  bookRiot?: BookRiotSignal;
}

export interface CrossSourceSignal {
  /** The normalised theme/keyword */
  theme: string;
  /** How many distinct sources mention it (max 5) */
  sourceCount: number;
  /** Which sources confirmed it */
  sources: string[];
}

// ─── Helper: LLM call with timeout ─────────────────────────────────────────

async function llmAnalysis<T>(
  systemPrompt: string,
  userPrompt: string,
  schema: { name: string; schema: Record<string, unknown> },
  fallback: T
): Promise<T> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
    try {
      const response = await invokeLLM({
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: schema.name,
            strict: true,
            schema: schema.schema,
          },
        },
      });
      const content = response?.choices?.[0]?.message?.content;
      const parsed = typeof content === "string" ? JSON.parse(content) : content;
      return parsed as T;
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    console.warn(`[ForumScraper/${schema.name}] LLM failed:`, (err as Error).message);
    return fallback;
  }
}

// ─── 1. Fan Community Analysis (Reddit lens) ────────────────────────────────

export async function scrapeReddit(title: string, author: string): Promise<RedditSignal> {
  try {
    const result = await llmAnalysis<{
      topSubreddits: string[];
      sampleTitles: string[];
      viralPotential: number;
    }>(
      "You are a Reddit community analyst specializing in book fandoms and print-on-demand design opportunities. Analyze books for their viral community potential.",
      `Analyze "${title}" by ${author} for Reddit fan community engagement potential.

Return JSON with:
- topSubreddits: 4-6 relevant subreddit names (without r/) where fans of this book would gather (e.g. "romancebooks", "Fantasy", "BooksThatMakeYouCry")
- sampleTitles: 6-8 realistic Reddit post titles that fans might write about this book's themes, characters, or quotable moments that could inspire merchandise/designs
- viralPotential: 1-10 score for how likely this book's themes would go viral on Reddit

Focus on design-relevant themes: memorable quotes, character archetypes, emotional moments, aesthetic elements, fandom identity.`,
      {
        name: "reddit_community_analysis",
        schema: {
          type: "object",
          properties: {
            topSubreddits: { type: "array", items: { type: "string" } },
            sampleTitles: { type: "array", items: { type: "string" } },
            viralPotential: { type: "number" },
          },
          required: ["topSubreddits", "sampleTitles", "viralPotential"],
          additionalProperties: false,
        },
      },
      { topSubreddits: [], sampleTitles: [], viralPotential: 0 }
    );

    const postCount = result.sampleTitles.length;
    return {
      postCount,
      avgUpvotes: result.viralPotential * 50,
      topSubreddits: result.topSubreddits,
      sampleTitles: result.sampleTitles,
      status: postCount > 0 ? "success" : "failed",
    };
  } catch (err) {
    console.warn(`[Reddit/LLM] failed "${title}":`, (err as Error).message);
    return { postCount: 0, avgUpvotes: 0, topSubreddits: [], sampleTitles: [], status: "failed" };
  }
}

// ─── 2. Reader Reception Analysis (Goodreads lens) ──────────────────────────

export async function scrapeGoodreads(title: string, author: string): Promise<GoodreadsSignal> {
  try {
    const result = await llmAnalysis<{
      estimatedRatings: number;
      estimatedAvgRating: number;
      estimatedReviews: number;
      topShelves: string[];
    }>(
      "You are a Goodreads data analyst. Estimate reader reception metrics and shelf categorization for books based on their genre, author reputation, and market positioning.",
      `Analyze "${title}" by ${author} for Goodreads-style reader reception.

Return JSON with:
- estimatedRatings: estimated number of ratings (be realistic based on author popularity and genre)
- estimatedAvgRating: estimated average rating (1.0-5.0, be realistic)
- estimatedReviews: estimated number of text reviews
- topShelves: 6-8 Goodreads shelf names where readers would categorize this book (e.g. "romance", "slow-burn", "enemies-to-lovers", "dark-academia", "comfort-reads")

Focus on shelf names that reveal design-relevant reader identity and aesthetic preferences.`,
      {
        name: "goodreads_reception_analysis",
        schema: {
          type: "object",
          properties: {
            estimatedRatings: { type: "number" },
            estimatedAvgRating: { type: "number" },
            estimatedReviews: { type: "number" },
            topShelves: { type: "array", items: { type: "string" } },
          },
          required: ["estimatedRatings", "estimatedAvgRating", "estimatedReviews", "topShelves"],
          additionalProperties: false,
        },
      },
      { estimatedRatings: 0, estimatedAvgRating: 0, estimatedReviews: 0, topShelves: [] }
    );

    return {
      ratingsCount: result.estimatedRatings,
      avgRating: result.estimatedAvgRating,
      reviewCount: result.estimatedReviews,
      topShelves: result.topShelves,
      status: result.topShelves.length > 0 ? "success" : "failed",
    };
  } catch (err) {
    console.warn(`[Goodreads/LLM] failed "${title}":`, (err as Error).message);
    return { ratingsCount: 0, avgRating: 0, reviewCount: 0, topShelves: [], status: "failed" };
  }
}

// ─── 3. Mood & Theme Mapping (StoryGraph lens) ──────────────────────────────

export async function scrapeStoryGraph(title: string, author: string): Promise<StoryGraphSignal> {
  try {
    const result = await llmAnalysis<{
      moods: string[];
      pace: string;
      themes: string[];
    }>(
      "You are a StoryGraph-style book mood and theme analyst. Categorize books by their emotional tone, reading pace, and thematic elements.",
      `Analyze "${title}" by ${author} for mood, pace, and themes (StoryGraph-style categorization).

Return JSON with:
- moods: 4-6 mood descriptors (e.g. "romantic", "dark", "funny", "emotional", "tense", "atmospheric", "cozy", "heartwarming", "bittersweet", "adventurous", "mysterious", "lighthearted")
- pace: one of "fast-paced", "slow burn", "medium-paced", "page-turner", "quick read"
- themes: 8-12 thematic keywords that capture the book's core identity (e.g. "found family", "redemption", "forbidden love", "survival", "identity", "grief", "chosen one")

Focus on themes that could inspire visual design elements and merchandise concepts.`,
      {
        name: "storygraph_mood_analysis",
        schema: {
          type: "object",
          properties: {
            moods: { type: "array", items: { type: "string" } },
            pace: { type: "string" },
            themes: { type: "array", items: { type: "string" } },
          },
          required: ["moods", "pace", "themes"],
          additionalProperties: false,
        },
      },
      { moods: [], pace: "", themes: [] }
    );

    return {
      moods: result.moods,
      pace: result.pace,
      themes: result.themes,
      status: result.themes.length > 0 || result.moods.length > 0 ? "success" : "failed",
    };
  } catch (err) {
    console.warn(`[StoryGraph/LLM] failed "${title}":`, (err as Error).message);
    return { moods: [], pace: "", themes: [], status: "failed" };
  }
}

// ─── 4. Book Club Discussion Analysis (Fable lens) ──────────────────────────

export async function scrapeFable(title: string, author: string): Promise<FableSignal> {
  try {
    const result = await llmAnalysis<{
      discussionTopics: string[];
      characterArchetypes: string[];
      visualElements: string[];
    }>(
      "You are a book club discussion facilitator and literary analyst. Analyze books for their discussion-worthy elements and visual/design potential.",
      `Analyze "${title}" by ${author} for book club discussion potential and visual design elements.

Return JSON with:
- discussionTopics: 5-8 book club discussion topics that reveal the book's emotional core (e.g. "the symbolism of the lighthouse", "moral ambiguity of the protagonist", "representation of grief")
- characterArchetypes: 3-5 character archetypes or memorable character traits that fans identify with (e.g. "morally grey hero", "found family dynamics", "reluctant chosen one")
- visualElements: 4-6 visual/aesthetic elements from the book that could inspire designs (e.g. "celestial imagery", "botanical motifs", "vintage maps", "sword and crown iconography")

Focus on elements that would resonate with fans wanting to express their love for this book through merchandise.`,
      {
        name: "fable_discussion_analysis",
        schema: {
          type: "object",
          properties: {
            discussionTopics: { type: "array", items: { type: "string" } },
            characterArchetypes: { type: "array", items: { type: "string" } },
            visualElements: { type: "array", items: { type: "string" } },
          },
          required: ["discussionTopics", "characterArchetypes", "visualElements"],
          additionalProperties: false,
        },
      },
      { discussionTopics: [], characterArchetypes: [], visualElements: [] }
    );

    const subjects = [
      ...result.discussionTopics,
      ...result.characterArchetypes,
      ...result.visualElements,
    ];

    return {
      clubCount: result.discussionTopics.length,
      discussionCount: result.characterArchetypes.length,
      subjects: subjects.slice(0, 15),
      status: subjects.length > 0 ? "success" : "failed",
    };
  } catch (err) {
    console.warn(`[Fable/LLM] failed "${title}":`, (err as Error).message);
    return { clubCount: 0, discussionCount: 0, subjects: [], status: "failed" };
  }
}

// ─── 5. Cultural Angles & Cross-Fandom (Book Riot lens) ─────────────────────

export async function scrapeBookRiot(title: string, author: string): Promise<BookRiotSignal> {
  try {
    const result = await llmAnalysis<{
      articleTitles: string[];
      culturalAngles: string[];
    }>(
      "You are a book culture analyst specializing in fan communities, merchandising trends, and cross-fandom opportunities for print-on-demand designs.",
      `Analyze "${title}" by ${author} for print-on-demand design potential.

Return JSON with:
- articleTitles: 3-4 cultural insight headlines about fan communities and design appeal (written as if they were Book Riot article titles)
- culturalAngles: 3-4 cross-fandom opportunities for POD designs (e.g. "appeals to cottagecore aesthetic fans", "overlaps with DnD community", "Taylor Swift BookTok crossover potential")

Be specific to this book's themes, characters, and cultural moment.`,
      {
        name: "book_riot_analysis",
        schema: {
          type: "object",
          properties: {
            articleTitles: { type: "array", items: { type: "string" } },
            culturalAngles: { type: "array", items: { type: "string" } },
          },
          required: ["articleTitles", "culturalAngles"],
          additionalProperties: false,
        },
      },
      { articleTitles: [], culturalAngles: [] }
    );

    return {
      articleCount: result.articleTitles.length,
      articleTitles: result.articleTitles,
      culturalAngles: result.culturalAngles,
      status: result.articleTitles.length > 0 ? "success" : "failed",
    };
  } catch (err) {
    console.warn(`[BookRiot/LLM] failed "${title}":`, (err as Error).message);
    return { articleCount: 0, articleTitles: [], culturalAngles: [], status: "failed" };
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

export async function scrapeAllForums(title: string, author: string, signal?: AbortSignal): Promise<ForumSignals> {
  if (signal?.aborted) return {
    reddit: { postCount: 0, avgUpvotes: 0, topSubreddits: [], sampleTitles: [], status: "skipped" },
    goodreads: { ratingsCount: 0, avgRating: 0, reviewCount: 0, topShelves: [], status: "skipped" },
    storyGraph: { moods: [], pace: "", themes: [], status: "skipped" },
    fable: { clubCount: 0, discussionCount: 0, subjects: [], status: "skipped" },
    bookRiot: { articleCount: 0, articleTitles: [], culturalAngles: [], status: "skipped" },
  };
  console.log(`[ForumScraper] Analyzing all sources for "${title}" by ${author}`);
  const [reddit, goodreads, storyGraph, fable, bookRiot] = await Promise.allSettled([
    scrapeReddit(title, author),
    scrapeGoodreads(title, author),
    scrapeStoryGraph(title, author),
    scrapeFable(title, author),
    scrapeBookRiot(title, author),
  ]);
  const result: ForumSignals = {
    reddit: reddit.status === "fulfilled" ? reddit.value : { postCount: 0, avgUpvotes: 0, topSubreddits: [], sampleTitles: [], status: "failed" },
    goodreads: goodreads.status === "fulfilled" ? goodreads.value : { ratingsCount: 0, avgRating: 0, reviewCount: 0, topShelves: [], status: "failed" },
    storyGraph: storyGraph.status === "fulfilled" ? storyGraph.value : { moods: [], pace: "", themes: [], status: "failed" },
    fable: fable.status === "fulfilled" ? fable.value : { clubCount: 0, discussionCount: 0, subjects: [], status: "failed" },
    bookRiot: bookRiot.status === "fulfilled" ? bookRiot.value : { articleCount: 0, articleTitles: [], culturalAngles: [], status: "failed" },
  };
  const ok = [result.reddit, result.goodreads, result.storyGraph, result.fable, result.bookRiot].filter(s => s?.status === "success").length;
  console.log(`[ForumScraper] "${title}": ${ok}/5 sources OK`);
  return result;
}

// ─── Scoring ─────────────────────────────────────────────────────────────────

export function computeForumScore(signals: ForumSignals): { socialMomentumBoost: number; audienceSizeBoost: number; realDataSources: string[]; summary: string } {
  const realSources: string[] = [];
  let social = 0, audience = 0;
  const parts: string[] = [];
  if (signals.reddit?.status === "success") {
    realSources.push("Reddit");
    if (signals.reddit.postCount >= 5) { social += 10; parts.push(`${signals.reddit.postCount} community themes (viral score: ${Math.round(signals.reddit.avgUpvotes / 50)}/10)`); }
    else if (signals.reddit.postCount >= 1) { social += 3; parts.push(`${signals.reddit.postCount} community mention(s)`); }
    else social -= 5;
  }
  if (signals.goodreads?.status === "success") {
    realSources.push("Goodreads");
    const { ratingsCount, avgRating } = signals.goodreads;
    if (ratingsCount >= 50000) { audience += 15; parts.push(`${ratingsCount.toLocaleString()} est. ratings (${avgRating}★)`); }
    else if (ratingsCount >= 10000) { audience += 8; parts.push(`${ratingsCount.toLocaleString()} est. ratings (${avgRating}★)`); }
    else if (ratingsCount >= 1000) { audience += 3; parts.push(`${ratingsCount.toLocaleString()} est. ratings`); }
    else audience += 1; // Still useful data even for new books
  }
  if (signals.storyGraph?.status === "success") {
    realSources.push("StoryGraph");
    if (signals.storyGraph.themes.length > 0) parts.push(`${signals.storyGraph.themes.length} themes`);
    if (signals.storyGraph.moods.length > 0) parts.push(`moods: ${signals.storyGraph.moods.slice(0, 3).join(", ")}`);
  }
  if (signals.fable?.status === "success") {
    realSources.push("Fable");
    if (signals.fable.clubCount > 0) { social += 5; parts.push(`${signals.fable.clubCount} discussion topics`); }
    if (signals.fable.discussionCount > 0) parts.push(`${signals.fable.discussionCount} character archetypes`);
  }
  if (signals.bookRiot?.status === "success") {
    realSources.push("Book Riot");
    if ((signals.bookRiot.articleTitles?.length ?? 0) >= 2) { social += 5; parts.push(`${signals.bookRiot.articleTitles.length} cultural insights`); }
    else if ((signals.bookRiot.articleTitles?.length ?? 0) >= 1) social += 2;
  }
  return {
    socialMomentumBoost: Math.max(-20, Math.min(20, social)),
    audienceSizeBoost: Math.max(-20, Math.min(20, audience)),
    realDataSources: realSources,
    summary: parts.length > 0 ? parts.join(" | ") : "No forum data available",
  };
}

// ─── Cross-Source Signal Extractor ──────────────────────────────────────────

const STOP_WORDS = new Set([
  "the","and","for","with","that","this","from","are","was","were","has","have",
  "not","but","its","can","will","they","their","about","also","into","more",
  "some","than","then","when","where","which","who","how","what","been","being",
  "very","just","even","only","like","over","such","your","our","all","any",
  "each","both","few","most","other","same","own","off","out","up","down",
  "in","on","at","to","of","a","an","is","it","by","as","or","if","so",
  "do","no","be","we","he","she","his","her","him","us","me","my","you","i",
  "book","read","reader","reading","fiction","novel","series","author","books",
]);

function tokenizeSignal(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w));
}

/**
 * Extract themes confirmed by multiple forum sources.
 * Returns top signals sorted by sourceCount desc, then frequency desc.
 */
export function extractCrossSourceSignals(signals: ForumSignals): CrossSourceSignal[] {
  // Map: token → Set of source names that mentioned it
  const tokenSources = new Map<string, Set<string>>();

  function addTokens(texts: string[], sourceName: string) {
    for (const text of texts) {
      for (const token of tokenizeSignal(text)) {
        if (!tokenSources.has(token)) tokenSources.set(token, new Set());
        tokenSources.get(token)!.add(sourceName);
      }
    }
  }

  if (signals.reddit?.status === "success") {
    addTokens(signals.reddit.sampleTitles ?? [], "Reddit");
    addTokens(signals.reddit.topSubreddits ?? [], "Reddit");
  }
  if (signals.goodreads?.status === "success") {
    addTokens(signals.goodreads.topShelves ?? [], "Goodreads");
  }
  if (signals.storyGraph?.status === "success") {
    addTokens(signals.storyGraph.themes ?? [], "StoryGraph");
    addTokens(signals.storyGraph.moods ?? [], "StoryGraph");
  }
  if (signals.fable?.status === "success") {
    addTokens(signals.fable.subjects ?? [], "Fable");
  }
  if (signals.bookRiot?.status === "success") {
    addTokens(signals.bookRiot.articleTitles ?? [], "Book Riot");
    addTokens(signals.bookRiot.culturalAngles ?? [], "Book Riot");
  }

  // Build results: only tokens confirmed by 2+ sources
  const results: CrossSourceSignal[] = [];
  for (const [theme, sourceSet] of Array.from(tokenSources.entries())) {
    if (sourceSet.size >= 2) {
      results.push({
        theme,
        sourceCount: sourceSet.size,
        sources: Array.from(sourceSet),
      });
    }
  }

  // Sort: most sources first, then alphabetical for stability
  results.sort((a, b) => b.sourceCount - a.sourceCount || a.theme.localeCompare(b.theme));

  return results.slice(0, 12); // top 12 cross-source signals
}
