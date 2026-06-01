/**
 * Per-Book Refresh Pipeline (v4)
 *
 * Mini-pipeline that re-processes a single book:
 * 1. Re-scrape all 5 forums for fresh signals
 * 2. Re-score the book with updated forum data
 * 3. Generate 5 NEW design concepts (preserving old ones)
 * 4. Score the new concepts
 * 5. If any new concept is top-scoring, generate images
 *
 * Old concepts are preserved — new ones are marked with refreshSource = "book_refresh".
 */

import { invokeLLM } from "./_core/llm";
import { generateImage } from "./_core/imageGeneration";
import {
  getBookById,
  updateBookExtraction,
  updateBookScores,
  updateBookForumSignals,
  updateBookRefreshedAt,
  insertConcept,
  getConceptsByBookId,
  insertNicheResearch,
  getNicheResearchByBookId,
  updateConceptImages,
  updateConceptScore,
} from "./db";
import { scrapeAllForums, computeForumScore, type ForumSignals } from "./forumScraper";
import { stageWorldBible } from "./pipeline";

// Track active refreshes to prevent concurrent refreshes on same book
const activeRefreshes = new Map<number, { status: string; progress: number }>();

export function getRefreshStatus(bookId: number) {
  return activeRefreshes.get(bookId) ?? { status: "Idle", progress: 0 };
}

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

export async function refreshBook(bookId: number): Promise<{ success: boolean; message: string; newConceptCount: number }> {
  if (activeRefreshes.has(bookId)) {
    return { success: false, message: "Refresh already in progress for this book.", newConceptCount: 0 };
  }

  const book = await getBookById(bookId);
  if (!book) {
    return { success: false, message: "Book not found.", newConceptCount: 0 };
  }

  activeRefreshes.set(bookId, { status: "Scraping forums...", progress: 20 });

  try {
    // Step 1: Re-scrape forums
    let forumSignals: ForumSignals | null = null;
    try {
      forumSignals = await scrapeAllForums(book.title, book.author);
      await updateBookForumSignals(bookId, forumSignals);
      console.log(`[BookRefresh] Forum scraping complete for "${book.title}"`);
    } catch (err) {
      console.warn(`[BookRefresh] Forum scraping failed for "${book.title}" (non-fatal):`, err);
    }

    activeRefreshes.set(bookId, { status: "Updating scores...", progress: 40 });

    // Step 2: Apply forum boosts to book scores
    if (forumSignals) {
      const { socialMomentumBoost, audienceSizeBoost } = computeForumScore(forumSignals);
      if (socialMomentumBoost !== 0 || audienceSizeBoost !== 0) {
        const newSocial = Math.max(0, Math.min(100, (book.socialMomentum ?? 0) + socialMomentumBoost));
        const newAudience = Math.max(0, Math.min(100, (book.audienceSize ?? 0) + audienceSizeBoost));
        const newTotal = newSocial + (book.designNovelty ?? 0) + newAudience;
        await updateBookScores(bookId, {
          trendScoreTotal: newTotal,
          socialMomentum: newSocial,
          socialRationale: `${book.socialRationale ?? ""} [Refresh boost: +${socialMomentumBoost}]`,
          designNovelty: book.designNovelty ?? 0,
          designRationale: book.designRationale ?? "",
          audienceSize: newAudience,
          audienceRationale: `${book.audienceRationale ?? ""} [Refresh boost: +${audienceSizeBoost}]`,
        });
      }
    }

    // Step 2b: Extract / refresh World Bible
    activeRefreshes.set(bookId, { status: "Building World Bible...", progress: 50 });
    try {
      await stageWorldBible([{
        id: book.id,
        title: book.title,
        author: book.author,
        synopsis: book.synopsis,
        mood: book.mood,
        setting: book.setting,
        subgenre: book.subgenre,
      }]);
      console.log(`[BookRefresh] World Bible extracted for "${book.title}"`);
    } catch (err) {
      console.warn(`[BookRefresh] World Bible extraction failed for "${book.title}" (non-fatal):`, err);
    }

    activeRefreshes.set(bookId, { status: "Generating new concepts...", progress: 60 });

    // Step 3: Generate 5 new concepts
    const niche = await getNicheResearchByBookId(bookId);
    const nicheData = niche ? {
      fanConversations: niche.fanConversations,
      designStyles: niche.designStyles,
      whiteSpace: niche.whiteSpace,
    } : null;

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

IMPORTANT: These concepts must be DIFFERENT from any previous concepts for this book. Explore new fan phrases and angles.

Return a JSON object with a "concepts" array of exactly 5 objects:
{
  "concepts": [{
    "concept_name": "string — short, evocative name (2-4 words)",
    "source_phrase": "string — the exact real fan phrase/quote this concept is anchored to",
    "humor_framework": "string — one of: cultural-insider, style-forward, white-space, anti-joke, cross-reference (let the phrase dictate this)",
    "format": "string — one of: t-shirt, hoodie, tote bag, sticker, bookmark, mug, sweatshirt, enamel pin, phone case, poster",
    "style": "string — derived from the book's visual universe (must match the book's actual aesthetic)",
    "headline": "string — the source_phrase itself or a direct minimal adaptation. NOT the book title.",
    "subtext": "string — optional secondary text",
    "color_palette": ["3-4 hex codes derived from the book's dominant colors"],
    "layout_description": "string — references the book's visual motifs and art style",
    "font_suggestion": "string — matches the book's typography aesthetic",
    "signal_tags": ["confirmed cross-source signals this concept uses (empty array if none)"],
    "copyright_safe": true
  }]
}
Return ONLY the JSON object.`;

    // Style Intelligence: read directives computed by Stage 5.5 of last full run (graceful: may be null)
    const sd = book.styleDirectives as { primaryAesthetic?: string; colorDirective?: string; maxColors?: number; typographyStyle?: string; avoidDirectives?: string[]; marketReference?: string } | null | undefined;
    const styleIntelligenceBlock = sd?.primaryAesthetic
      ? `\nMARKET-DERIVED STYLE INTELLIGENCE (from prior pipeline run):\nPrimary Aesthetic: ${sd.primaryAesthetic}\nColor Directive: ${sd.colorDirective ?? "not specified"}\nMax Colors: ${sd.maxColors ?? 4}\nTypography Style: ${sd.typographyStyle ?? "not specified"}\nAVOID: ${(sd.avoidDirectives ?? []).join(", ") || "none"}\nMarket Reference: ${sd.marketReference ?? "not specified"}\n\nConcept style fields MUST align with the Market-Derived Style Intelligence above.`
      : "";

    const userMsg = `Book aesthetic profile:
Subgenre: ${book.subgenre ?? "unknown"}
Mood: ${book.mood ?? "unknown"}
Setting: ${book.setting ?? "unknown"}
Color Palette: ${(book.dominantColors ?? []).join(", ") || "not specified"}
Visual Motifs: ${(book.visualMotifs ?? []).join(", ") || "not specified"}
Typography: ${book.typographyStyle ?? "not specified"}
Fan Culture: ${book.fanCulture ?? "not specified"}${styleIntelligenceBlock}

NICHE RESEARCH:
Fan Conversations: ${nicheData ? JSON.stringify(nicheData.fanConversations) : "No research available"}
Design Styles: ${nicheData ? JSON.stringify(nicheData.designStyles) : "No research available"}
White Space Opportunities: ${nicheData ? JSON.stringify(nicheData.whiteSpace) : "No research available"}

FORUM SIGNALS (FRESH DATA):
${forumSignals ? JSON.stringify(forumSignals, null, 2) : "No forum data available"}`;

    let newConceptCount = 0;
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
        `Refresh concepts for "${book.title}"`
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

      if (Array.isArray(conceptsArray)) {
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
            nicheResearchId: niche?.id ?? null,
            signalTags: Array.isArray(c.signal_tags) ? c.signal_tags : [],
            sourcePhrase: c.source_phrase ?? null,
            refreshSource: "book_refresh",
          });
          newConceptCount++;
        }
      }
    } catch (err) {
      console.warn(`[BookRefresh] Concept generation failed for "${book.title}":`, err);
    }

    activeRefreshes.set(bookId, { status: "Scoring new concepts...", progress: 80 });

    // Step 4: Score the new concepts
    if (newConceptCount > 0) {
      const allConcepts = await getConceptsByBookId(bookId);
      const newConcepts = allConcepts.filter(c => c.refreshSource === "book_refresh" && !c.trendScore);

      if (newConcepts.length > 0) {
        const SCORING_SYSTEM = `Score each design concept on 3 dimensions (0-100 each). Return JSON:
{
  "scores": [{
    "concept_id": number,
    "social_momentum": { "score": number, "rationale": "string" },
    "design_novelty": { "score": number, "rationale": "string" },
    "audience_size": { "score": number, "rationale": "string" },
    "total_score": number
  }]
}
Be CRITICAL. Use the FULL range (20-95). total_score = sum of 3 scores.`;

        const scoringInput = newConcepts.map(c => ({
          concept_id: c.id,
          concept_name: c.conceptName,
          humor_framework: c.humorFramework,
          format: c.format,
          style: c.style,
          headline: c.headline,
          niche_research: nicheData,
        }));

        try {
          const scoreResult = await withTimeout(
            invokeLLM({
              messages: [
                { role: "system", content: SCORING_SYSTEM },
                { role: "user", content: JSON.stringify(scoringInput) },
              ],
              response_format: { type: "json_object" },
            }),
            30_000,
            "Score refresh concepts"
          );

          const scoreContent = typeof scoreResult.choices[0]?.message?.content === "string"
            ? scoreResult.choices[0].message.content
            : "";
          let scoreParsed = JSON.parse(scoreContent);
          let scoresArray = scoreParsed.scores ?? scoreParsed;
          if (!Array.isArray(scoresArray)) {
            const keys = Object.keys(scoreParsed);
            for (const key of keys) {
              if (Array.isArray(scoreParsed[key])) {
                scoresArray = scoreParsed[key];
                break;
              }
            }
          }

          if (Array.isArray(scoresArray)) {
            for (const score of scoresArray) {
              const total = score.total_score ??
                ((score.social_momentum?.score ?? 0) +
                 (score.design_novelty?.score ?? 0) +
                 (score.audience_size?.score ?? 0));
              await updateConceptScore(score.concept_id, total);
            }
          }
        } catch (err) {
          console.warn(`[BookRefresh] Scoring failed for "${book.title}":`, err);
        }
      }
    }

    // Step 5: Update book refreshedAt
    await updateBookRefreshedAt(bookId);

    activeRefreshes.set(bookId, { status: "Complete", progress: 100 });

    // Clean up after a short delay so the UI can read the final status
    setTimeout(() => activeRefreshes.delete(bookId), 5000);

    return {
      success: true,
      message: `Refresh complete. Generated ${newConceptCount} new concepts.`,
      newConceptCount,
    };
  } catch (err: any) {
    activeRefreshes.delete(bookId);
    console.error(`[BookRefresh] Failed for book ${bookId}:`, err);
    return { success: false, message: err?.message ?? "Refresh failed.", newConceptCount: 0 };
  }
}
