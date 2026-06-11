import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, protectedProcedure, router } from "./_core/trpc";
import { z } from "zod";
import {
  getLatestCompletedRun,
  getLatestRun,
  listRuns,
  listRunsByWorkspace,
  getLatestRunByWorkspace,
  getLatestCompletedRunByWorkspace,
  getRunById,
  getBooksByRunId,
  getBooksByIds,
  getBookById,
  getConceptsByBookId,

  getConceptsByRunId,
  toggleFavorite,
  getFavorites,
  getDistinctFormats,
  getDistinctStyles,
  getDistinctSubgenres,
  getDistinctHumorFrameworks,
  getNicheResearchByBookId,
  getNicheResearchByRunId,
  getMarketValidationByConceptId,
  getMarketValidationsByConceptIds,
  getHighScoringConcepts,
  failRun,
  // V4 new helpers
  getAllConcepts,
  getBookRegistry,
  getBookTrendData,
  getConceptById,
  getConceptWithBookById,
  updateConceptProductionUrl,
  getDistinctBookTitles,
  updateBookForumSignals,
  deleteConceptById,
  updateConceptImages,
  getOrCreateManualUploadBook,
  insertConcept,
  updateConceptStyle,
} from "./db";
import { runPipeline, recoverStaleRuns, regenerateImagesForRun } from "./pipeline";
import { processConceptProductionImages, processDesignForProduction } from "./productionImageProcessor";
import { refreshBook, getRefreshStatus } from "./bookRefresh";
import { workspaceRouter } from "./workspaceRouter";
import { onboardingRouter } from "./onboardingRouter";
import { productGroupRouter } from "./productGroupRouter";
import { nicheHunterRouter } from "./nicheHunterRouter";
import { mockupRouter } from "./mockupRouter";
import { revisionRouter } from "./revisionRouter";
import { listingRouter } from "./listingRouter";
import { bakeoffRouter } from "./bakeoffRouter";
import { generateImage } from "./_core/imageGeneration";
import { invokeLLM } from "./_core/llm";
import { storagePut } from "./storage";
import { checkHealth, getCircuitState } from "./selfHeal";
import { healingLog } from "../drizzle/schema";
import { desc, eq } from "drizzle-orm";
import { designConcepts } from "../drizzle/schema";
import { getDb } from "./db";

// Track running pipeline to prevent concurrent runs
let pipelineRunning = false;

// Recover any stale runs from previous deploys on startup
recoverStaleRuns().catch((err) =>
  console.warn("[Startup] Stale run recovery failed:", err)
);

export const appRouter = router({
  system: systemRouter,
  workspace: workspaceRouter,
  onboarding: onboardingRouter,
  productGroup: productGroupRouter,
  nicheHunter: nicheHunterRouter,
  mockup: mockupRouter,
  revision: revisionRouter,
  listing: listingRouter,
  bakeoff: bakeoffRouter, // TEMPORARY model bake-off harness — remove after routing decided

  auth: router({
    me: publicProcedure.query((opts) => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return { success: true } as const;
    }),
  }),

  pipeline: router({
    /**
     * Trigger a new pipeline run. Requires NYT API key from env.
     * Optionally uses Etsy API key for market validation.
     * Returns the run ID immediately; pipeline executes in background.
     */
    triggerRun: protectedProcedure
      .input(z.object({ workspaceId: z.string() }))
      .mutation(async ({ input }) => {
        if (pipelineRunning) {
          return {
            success: false,
            message: "A pipeline run is already in progress.",
            runId: null,
          };
        }

        // Look up workspace to determine pipeline source
        const { getWorkspaceById } = await import("./workspaceDb");
        const workspace = await getWorkspaceById(input.workspaceId);
        if (!workspace) {
          return {
            success: false,
            message: "Workspace not found.",
            runId: null,
          };
        }

        // Etsy v3 requires 'keystring:shared_secret' format in x-api-key header
        const rawEtsyKey = process.env.ETSY_API_KEY;
        const rawEtsySecret = process.env.ETSY_API_SECRET;
        const etsyApiKey = rawEtsyKey && rawEtsySecret
          ? `${rawEtsyKey}:${rawEtsySecret}`
          : rawEtsyKey || undefined;

        if (workspace.workspaceType === "nyt") {
          const nytApiKey = process.env.NYT_API_KEY;
          if (!nytApiKey) {
            return {
              success: false,
              message: "NYT_API_KEY is not configured. Add it in Settings > Secrets.",
              runId: null,
            };
          }

          pipelineRunning = true;
          runPipeline({
            workspaceId: input.workspaceId,
            workspaceType: "nyt",
            nytApiKey,
            etsyApiKey,
          })
            .catch((err) => console.error("[Pipeline] Run failed:", err))
            .finally(() => { pipelineRunning = false; });
        } else {
          // niche_hunter workspace — no NYT key needed
          const nicheProfile = workspace.nicheProfile;
          if (!nicheProfile) {
            return {
              success: false,
              message: "Workspace has no niche profile. Complete the onboarding wizard first.",
              runId: null,
            };
          }

          pipelineRunning = true;
          runPipeline({
            workspaceId: input.workspaceId,
            workspaceType: "niche_hunter",
            nicheProfile: nicheProfile as import("./onboardingRouter").NicheProfile,
            etsyApiKey,
          })
            .catch((err) => console.error("[Pipeline] Run failed:", err))
            .finally(() => { pipelineRunning = false; });
        }

        // Wait briefly for the run to be created so we can return the ID
        await new Promise((r) => setTimeout(r, 500));

        const latestRun = await getLatestRunByWorkspace(input.workspaceId);
        return {
          success: true,
          message: "Pipeline started.",
          runId: latestRun?.id ?? null,
        };
      }),

    /**
     * Cancel a stuck or running pipeline run.
     * Marks it as failed in the DB and resets the in-memory flag.
     */
    cancelRun: protectedProcedure
      .input(z.object({ runId: z.number() }))
      .mutation(async ({ input }) => {
        const run = await getRunById(input.runId);
        if (!run) {
          return { success: false, message: "Run not found." };
        }
        if (run.status !== "running") {
          return { success: false, message: `Run is already ${run.status}.` };
        }

        await failRun(input.runId, "Manually cancelled by user.");
        pipelineRunning = false;

        return { success: true, message: "Run cancelled." };
      }),

    /**
     * Get the current status of the latest run (for live polling).
     */
    getStatus: publicProcedure.query(async () => {
      const run = await getLatestRun();

      // Auto-detect stale runs: if DB says "running" but in-memory flag is false,
      // the process restarted and the run is orphaned
      if (run && run.status === "running" && !pipelineRunning) {
        const ageMs = Date.now() - new Date(run.createdAt).getTime();
        // If older than 15 minutes and not tracked in memory, mark as failed
        if (ageMs > 15 * 60 * 1000) {
          await failRun(run.id, "Automatically recovered: server restarted while pipeline was running.");
          const updatedRun = await getLatestRun();
          return { run: updatedRun, isRunning: false };
        }
      }

      return {
        run,
        isRunning: pipelineRunning,
      };
    }),

    /**
     * Get a specific run by ID.
     */
    getRun: publicProcedure
      .input(z.object({ runId: z.number() }))
      .query(async ({ input }) => {
        return getRunById(input.runId);
      }),

    /**
     * Returns books from the current run that have concepts scoring 200+.
     * Called by the frontend BrowserScraper after Stage 5 completes.
     */
    getBrowserScrapeTargets: publicProcedure.query(async () => {
      const run = await getLatestRun();
      if (!run) return { runId: null, books: [], ready: false };
      // Only expose targets when pipeline is between stage 5 and 6 (browser scrape window)
      const isInWindow = run.currentStage === 5 || (run.currentStage === 6 && run.status === "running");
      if (!isInWindow) return { runId: run.id, books: [], ready: false };
      const highScoring = await getHighScoringConcepts(run.id, 200);
      if (highScoring.length === 0) return { runId: run.id, books: [], ready: false };
      // Get unique book IDs from high-scoring concepts
      const bookIds = Array.from(new Set(highScoring.map(c => c.bookId).filter(Boolean) as number[]));
      const allBooks = await getBooksByRunId(run.id);
      const targetBooks = allBooks
        .filter(b => bookIds.includes(b.id))
        .map(b => ({ id: b.id, title: b.title, author: b.author }));
      return { runId: run.id, books: targetBooks, ready: targetBooks.length > 0 };
    }),

    /**
     * Regenerate images for a completed run that has 0 images.
     * Safe to call on any completed run — only generates for concepts missing imageUrlA.
     */
    regenerateImages: protectedProcedure
      .input(z.object({ runId: z.number() }))
      .mutation(async ({ input }) => {
        if (pipelineRunning) {
          return { success: false, message: "Pipeline is currently running. Try again after it completes.", imagesGenerated: 0 };
        }
        const run = await getRunById(input.runId);
        if (!run) return { success: false, message: "Run not found.", imagesGenerated: 0 };
        if (run.status !== "completed") {
          return { success: false, message: `Run is ${run.status}, not completed.`, imagesGenerated: 0 };
        }
        pipelineRunning = true;
        try {
          const count = await regenerateImagesForRun(input.runId);
          return { success: true, message: `Generated ${count} images.`, imagesGenerated: count };
        } finally {
          pipelineRunning = false;
        }
      }),

    /**
     * Backfill production-ready transparent PNGs for all concepts in a run.
     * Processes concepts that have imageUrl* but no productionUrl*.
     * Safe to call multiple times — skips already-processed concepts.
     */
    processProductionImages: protectedProcedure
      .input(z.object({ runId: z.number() }))
      .mutation(async ({ input }) => {
        const run = await getRunById(input.runId);
        if (!run) return { success: false, message: "Run not found.", processed: 0, skipped: 0, failed: 0 };
        const concepts = await getConceptsByRunId(input.runId);
        let totalProcessed = 0, totalSkipped = 0, totalFailed = 0;
        for (const concept of concepts) {
          const result = await processConceptProductionImages(concept);
          totalProcessed += result.processed;
          totalSkipped += result.skipped;
          totalFailed += result.failed;
        }
        return {
          success: true,
          message: `Processed ${totalProcessed} images, skipped ${totalSkipped}, failed ${totalFailed}.`,
          processed: totalProcessed,
          skipped: totalSkipped,
          failed: totalFailed,
        };
      }),

    /**
     * Re-process production image for a single concept.
     * Clears existing productionUrl* and regenerates using the v2 magenta chromakey pipeline.
     * Use this to upgrade a single concept without running the full backfill.
     */
    reprocessProductionImage: protectedProcedure
      .input(z.object({
        conceptId: z.number(),
        variation: z.enum(["A", "B", "C"]).optional(),
      }))
      .mutation(async ({ input }) => {
        const concept = await getConceptById(input.conceptId);
        if (!concept) return { success: false, message: "Concept not found" };

        // Clear existing production URLs to force regeneration
        const db = await getDb();
        if (!db) return { success: false, message: "DB unavailable" };

        if (input.variation) {
          // Single variation
          const field = input.variation === "A" ? { productionUrlA: null }
            : input.variation === "B" ? { productionUrlB: null }
            : { productionUrlC: null };
          await db.update(designConcepts).set(field as any).where(eq(designConcepts.id, input.conceptId));
        } else {
          // All variations
          await db.update(designConcepts).set({
            productionUrlA: null,
            productionUrlB: null,
            productionUrlC: null,
          } as any).where(eq(designConcepts.id, input.conceptId));
        }

        // Re-fetch to get cleared state
        const refreshed = await getConceptById(input.conceptId);
        if (!refreshed) return { success: false, message: "Concept not found after clear" };

        const result = await processConceptProductionImages(refreshed);
        return {
          success: true,
          message: `Reprocessed: ${result.processed} done, ${result.failed} failed.`,
          ...result,
        };
      }),

    submitBrowserSignals: publicProcedure
      .input(z.object({
        bookId: z.number(),
        source: z.enum(["reddit", "storygraph", "fable"]),
        rawText: z.string().max(50_000),
      }))
      .mutation(async ({ input }) => {
        const book = await getBookById(input.bookId);
        if (!book) return { success: false, message: "Book not found" };
        // Parse raw text into signal data
        const existing = (book.forumSignals as any) ?? {};
        const lines = input.rawText.split("\n").map(l => l.trim()).filter(l => l.length > 3);
        const keywords = lines
          .flatMap(l => l.toLowerCase().match(/\b[a-z]{4,}\b/g) ?? [])
          .filter(w => !["that","this","with","from","have","been","they","their","about","when","which","also","into","more","some","than","then","where","will","just","even","only","over","such","your","both","most","other","same","each","very","what","book","novel","story","author","series","fiction","page","read","reading","books","https","http","www","reddit","comment","post","vote","upvote","score","user","reply","thread","link","click","view","show","hide","more","less","sort","filter","search","home","back","next","prev"].includes(w))
        const topKeywords = Array.from(new Set(keywords)).slice(0, 20);
        let updatedSignals = { ...existing };
        if (input.source === "reddit") {
          updatedSignals.reddit = {
            postCount: lines.length,
            avgUpvotes: 75, // browser = higher signal
            topSubreddits: ["r/books", "r/fantasy", "r/bookclub"].slice(0, 3),
            sampleTitles: topKeywords.slice(0, 10),
            status: "success",
          };
        } else if (input.source === "storygraph") {
          updatedSignals.storyGraph = {
            moods: topKeywords.filter(w => ["dark","emotional","funny","romantic","tense","atmospheric","cozy","uplifting","gritty","mysterious","adventurous","heartwarming"].some(m => w.includes(m))).slice(0, 6),
            pace: topKeywords.find(w => w.includes("fast") || w.includes("slow") || w.includes("quick")) ?? "",
            themes: topKeywords.slice(0, 12),
            status: "success",
          };
        } else if (input.source === "fable") {
          updatedSignals.fable = {
            clubCount: lines.filter(l => l.includes("club") || l.includes("group") || l.includes("circle")).length || topKeywords.length,
            discussionCount: lines.filter(l => l.includes("discuss") || l.includes("question") || l.includes("chapter")).length,
            subjects: topKeywords.slice(0, 15),
            status: "success",
          };
        }
        await updateBookForumSignals(input.bookId, updatedSignals);
        return { success: true, source: input.source, keywordsExtracted: topKeywords.length };
      }),
  }),

  reports: router({
    /**
     * Get the latest completed report with all books, concepts,
     * niche research, and market validation data.
     */
    getLatest: publicProcedure
      .input(z.object({ workspaceId: z.string().optional() }))
      .query(async ({ input }) => {
        const run = input.workspaceId
          ? await getLatestCompletedRunByWorkspace(input.workspaceId)
          : await getLatestCompletedRun();
        if (!run)
          return {
            run: null,
            books: [],
            concepts: [],
            nicheResearch: [],
            marketValidations: [],
          };

        const bks = await getBooksByRunId(run.id);
        const concepts = await getConceptsByRunId(run.id);
        const niche = await getNicheResearchByRunId(run.id);

        // Get market validations for all concepts
        const conceptIds = concepts.map((c) => c.id);
        const validations =
          conceptIds.length > 0
            ? await getMarketValidationsByConceptIds(conceptIds)
            : [];

        return {
          run,
          books: bks,
          concepts,
          nicheResearch: niche,
          marketValidations: validations,
        };
      }),

    /**
     * List past runs. Scoped to workspace when workspaceId is provided.
     */
    listHistory: publicProcedure
      .input(z.object({ workspaceId: z.string().optional() }))
      .query(async ({ input }) => {
        if (input.workspaceId) return listRunsByWorkspace(input.workspaceId, 50);
        return listRuns(50);
      }),

    /**
     * Get a specific report by run ID with all associated data.
     * Workspace isolation: if workspaceId is provided, the run MUST belong to that workspace.
     */
    getByRunId: publicProcedure
      .input(z.object({ runId: z.number(), workspaceId: z.string().optional() }))
      .query(async ({ input }) => {
        const run = await getRunById(input.runId);
        if (!run)
          return {
            run: null,
            books: [],
            concepts: [],
            nicheResearch: [],
            marketValidations: [],
          };

        // Workspace isolation gate: block cross-workspace data access
        if (input.workspaceId && run.workspaceId && run.workspaceId !== input.workspaceId) {
          return {
            run: null,
            books: [],
            concepts: [],
            nicheResearch: [],
            marketValidations: [],
          };
        }

        const concepts = await getConceptsByRunId(run.id);
        // Fetch books by the actual bookIds referenced by concepts
        // (handles cross-run references in niche_hunter workspaces)
        const conceptBookIds = Array.from(
          new Set(concepts.map((c) => c.bookId).filter(Boolean) as number[])
        );
        const bks = conceptBookIds.length > 0
          ? await getBooksByIds(conceptBookIds)
          : await getBooksByRunId(run.id);
        const niche = await getNicheResearchByRunId(run.id);

        const conceptIds = concepts.map((c) => c.id);
        const validations =
          conceptIds.length > 0
            ? await getMarketValidationsByConceptIds(conceptIds)
            : [];

        return {
          run,
          books: bks,
          concepts,
          nicheResearch: niche,
          marketValidations: validations,
        };
      }),
  }),

  books: router({
    /**
     * Get a single book with its design concepts, niche research,
     * and market validation data.
     * Workspace isolation: if workspaceId is provided, the book's run MUST belong to that workspace.
     */
    getById: publicProcedure
      .input(z.object({ bookId: z.number(), workspaceId: z.string().optional() }))
      .query(async ({ input }) => {
        const book = await getBookById(input.bookId);
        if (!book)
          return {
            book: null,
            concepts: [],
            nicheResearch: null,
            marketValidations: [],
          };

        // Workspace isolation gate: verify book's run belongs to this workspace
        if (input.workspaceId && book.runId) {
          const run = await getRunById(book.runId);
          if (run && run.workspaceId && run.workspaceId !== input.workspaceId) {
            return {
              book: null,
              concepts: [],
              nicheResearch: null,
              marketValidations: [],
            };
          }
        }

        // CRITICAL: Fetch ALL concepts across ALL runs for this ISBN.
        // FOREVER-ID: One book row per ISBN, all concepts belong to this single canonical ID
        const concepts = await getConceptsByBookId(book.id);
        const niche = await getNicheResearchByBookId(book.id);

        const conceptIds = concepts.map((c) => c.id);
        const validations =
          conceptIds.length > 0
            ? await getMarketValidationsByConceptIds(conceptIds)
            : [];

        return {
          book,
          concepts,
          nicheResearch: niche ?? null,
          marketValidations: validations,
        };
      }),

    /**
     * V4: Trigger a per-book refresh (re-scrape forums, generate new concepts).
     */
    refresh: protectedProcedure
      .input(z.object({ bookId: z.number() }))
      .mutation(async ({ input }) => {
        return refreshBook(input.bookId);
      }),

    /**
     * V4: Get the current refresh status for a book.
     */
    getRefreshStatus: publicProcedure
      .input(z.object({ bookId: z.number() }))
      .query(async ({ input }) => {
        return getRefreshStatus(input.bookId);
      }),
  }),

  favorites: router({
    /**
     * Toggle favorite status on a design concept.
     */
    toggle: protectedProcedure
      .input(z.object({ conceptId: z.number() }))
      .mutation(async ({ input }) => {
        const newState = await toggleFavorite(input.conceptId);
        return { isFavorite: newState };
      }),

    /**
     * Get all favorited concepts with optional filters.
     */
    list: publicProcedure
      .input(
        z
          .object({
            format: z.string().optional(),
            style: z.string().optional(),
            subgenre: z.string().optional(),
            humorFramework: z.string().optional(),
          })
          .optional()
      )
      .query(async ({ input }) => {
        const favorites = await getFavorites(input);
        return favorites;
      }),

    /**
     * Get distinct filter values for the favorites page.
     * Now includes humor frameworks.
     */
    getFilterOptions: publicProcedure.query(async () => {
      const [formats, styles, subgenres, humorFrameworks] = await Promise.all([
        getDistinctFormats(),
        getDistinctStyles(),
        getDistinctSubgenres(),
        getDistinctHumorFrameworks(),
      ]);
      return { formats, styles, subgenres, humorFrameworks };
    }),
  }),

  // ─── V4: Concept Library ──────────────────────────────────────────────

  library: router({
    /**
     * Get all concepts across all runs with filtering, pagination, sorting.
     */
    list: publicProcedure
      .input(z.object({
        workspaceId: z.string().optional(),
        limit: z.number().min(1).max(200).default(24),
        offset: z.number().min(0).default(0),
        bookTitle: z.string().optional(),
        winnersOnly: z.boolean().optional(),
        minScore: z.number().optional(),
        maxScore: z.number().optional(),
        format: z.string().optional(),
        style: z.string().optional(),
        humorFramework: z.string().optional(),
        sortBy: z.enum(["score", "date", "rank", "hasImages"]).optional(),
        sortDir: z.enum(["asc", "desc"]).optional(),
      }))
      .query(async ({ input }) => {
        return getAllConcepts(input);
      }),

    /**
     * Get filter options for the library page.
     */
    getFilterOptions: publicProcedure
      .input(z.object({ workspaceId: z.string().optional() }).optional())
      .query(async ({ input }) => {
        const [formats, styles, subgenres, humorFrameworks, bookTitles] = await Promise.all([
          getDistinctFormats(),
          getDistinctStyles(),
          getDistinctSubgenres(),
          getDistinctHumorFrameworks(),
          getDistinctBookTitles(input?.workspaceId),
        ]);
        return { formats, styles, subgenres, humorFrameworks, bookTitles };
      }),
    /**
     * Delete (permanently remove) a concept by ID.
     */
    deleteConcept: protectedProcedure
      .input(z.object({ conceptId: z.number() }))
      .mutation(async ({ input }) => {
        await deleteConceptById(input.conceptId);
        return { success: true };
      }),

    /**
     * Manually upload a design image as a new concept (no AI). Stores the image, attaches it to
     * the workspace's "Manual Uploads" book, and creates a concept with the image as Variation A —
     * so it shows in the Library and is immediately usable in Design Studio + Mockups. Stored
     * as-is (raw); the user can Clean & Trim it in the Design Studio.
     */
    uploadConcept: protectedProcedure
      .input(z.object({
        workspaceId: z.string(),
        name: z.string().min(1).max(255),
        imageBase64: z.string(),
        mimeType: z.enum(["image/jpeg", "image/png", "image/webp"]),
      }))
      .mutation(async ({ input }) => {
        const buffer = Buffer.from(input.imageBase64, "base64");
        const ext = input.mimeType === "image/jpeg" ? "jpg" : input.mimeType === "image/png" ? "png" : "webp";
        const { bookId, runId } = await getOrCreateManualUploadBook(input.workspaceId);
        const { url } = await storagePut(
          `manual-uploads/${input.workspaceId}/${Date.now()}.${ext}`,
          buffer,
          input.mimeType,
        );
        const conceptId = await insertConcept({
          bookId,
          runId,
          conceptName: input.name,
          format: "Manual",
          style: "Manual upload",
          imageUrlA: url,
        });
        return { success: true, conceptId, imageUrl: url };
      }),
  }),

  // ─── V4: Analytics ────────────────────────────────────────────────────

  analytics: router({
    /**
     * Get the book registry — all unique books across all runs.
     */
    getBookRegistry: publicProcedure
      .input(z.object({ workspaceId: z.string().optional() }).optional())
      .query(async ({ input }) => {
        return getBookRegistry(input?.workspaceId);
      }),

    /**
     * Get time-series trend data for a specific book (by ISBN).
     */
    getBookTrends: publicProcedure
      .input(z.object({
        isbn: z.string(),
        days: z.number().optional(),
      }))
      .query(async ({ input }) => {
        return getBookTrendData(input.isbn, input.days);
      }),
  }),

  // ─── V4: Production Export ────────────────────────────────────────────

  concepts: router({
    /**
     * Get a single concept by ID with book details.
     * Used by the lightbox to auto-fetch details when not provided.
     */
    getById: publicProcedure
      .input(z.object({ conceptId: z.number() }))
      .query(async ({ input }) => {
        const concept = await getConceptWithBookById(input.conceptId);
        if (!concept) return null;
        return concept;
      }),

    /**
     * Export a concept image variation as a production-ready transparent PNG.
     * Uses the image generation service in edit mode to remove backgrounds.
     * Caches the result in S3 for instant re-downloads.
     */
    /**
     * Generate images for a single concept that currently has no images.
     * Creates 3 variations using the standard pipeline prompt formula.
     */
    generateSingleImage: protectedProcedure
      .input(z.object({ conceptId: z.number() }))
      .mutation(async ({ input }) => {
        const concept = await getConceptById(input.conceptId);
        if (!concept) return { success: false, message: "Concept not found." };
        if (concept.imageUrlA || concept.imageUrlB || concept.imageUrlC) {
          return { success: false, message: "Concept already has images." };
        }

        // Build a simplified prompt for the concept
        const promptSystem = `You are a senior art director. Write THREE image generation prompts for a t-shirt graphic design concept. Each prompt should be detailed (200+ words) and describe a print-ready design with transparent/white background suitable for DTF printing. Aim for professional, commercial-grade, Etsy-bestseller quality: clean confident linework, rich purposeful detail, balanced focal composition, a deliberate limited color palette, crisp and polished — a design someone would actually buy. Render the design in the concept's stated art style. ABSOLUTE RULE: NEVER cartoonish, clip-art, kawaii, chibi, or childish/exaggerated cartoon styling — under any circumstances. Return ONLY a JSON object with keys: variation_a, variation_b, variation_c.`;
        const userMsg = `Design concept:
Name: ${concept.conceptName}
Format: ${concept.format}
Style: ${concept.style}
Headline: ${concept.headline ?? "none"}
Subtext: ${concept.subtext ?? "none"}
Color Palette: ${(concept.colorPalette as string[] ?? []).join(", ") || "not specified"}
Layout: ${concept.layoutDescription ?? "not specified"}
Font: ${concept.fontSuggestion ?? "not specified"}`;

        try {
          const promptResult = await invokeLLM({
            messages: [
              { role: "system", content: promptSystem },
              { role: "user", content: userMsg },
            ],
            response_format: { type: "json_object" },
          });

          const promptContent = typeof promptResult.choices[0]?.message?.content === "string"
            ? promptResult.choices[0].message.content : "";
          const parsed = JSON.parse(promptContent);
          const prompts = {
            A: parsed.variation_a ?? parsed.prompt ?? "",
            B: parsed.variation_b ?? "",
            C: parsed.variation_c ?? "",
          };

          // Generate images in parallel
          const results = await Promise.allSettled(
            (["A", "B", "C"] as const).filter(v => prompts[v]).map(async (variation) => {
              const img = await generateImage({ prompt: prompts[variation] });
              return { variation, url: img.url ?? null, prompt: prompts[variation] };
            })
          );

          const update: Parameters<typeof updateConceptImages>[1] = {};
          let generated = 0;
          for (const r of results) {
            if (r.status !== "fulfilled" || !r.value.url) continue;
            generated++;
            const { variation, url, prompt } = r.value;
            if (variation === "A") { update.imageUrlA = url; update.imagePromptA = prompt; }
            if (variation === "B") { update.imageUrlB = url; update.imagePromptB = prompt; }
            if (variation === "C") { update.imageUrlC = url; update.imagePromptC = prompt; }
          }

          if (Object.keys(update).length > 0) {
            await updateConceptImages(input.conceptId, update);
          }

          return { success: true, message: `Generated ${generated} images.` };
        } catch (err: any) {
          console.error(`[GenerateSingleImage] Failed for concept ${input.conceptId}:`, err);
          return { success: false, message: err?.message ?? "Image generation failed." };
        }
      }),

    /**
     * Regenerate a concept's images in a CHOSEN art style (manual re-roll) — so a good concept
     * isn't lost when its image came out wrong (e.g. cartoonish). Overwrites the 3 variations,
     * updates the concept's style label, and CLEARS the cached production renders so mockups
     * re-process the new image. Never cartoonish.
     */
    regenerateImage: protectedProcedure
      .input(z.object({
        conceptId: z.number(),
        style: z.string().min(1).max(200),
      }))
      .mutation(async ({ input }) => {
        const concept = await getConceptById(input.conceptId);
        if (!concept) return { success: false, message: "Concept not found." };

        const promptSystem = `You are a senior art director. Write THREE image generation prompts for a print-ready t-shirt graphic. Each: 200+ words, transparent/white background, DTF-ready. Aim for professional, commercial-grade, Etsy-bestseller quality: clean confident linework, rich purposeful detail, balanced focal composition, a deliberate limited color palette, crisp and polished — a design someone would actually buy. RENDER THE DESIGN ENTIRELY IN THIS ART STYLE: "${input.style}" — commit fully; every prompt must read unmistakably as that style. ABSOLUTE RULE: NEVER cartoonish, clip-art, kawaii, chibi, or childish/exaggerated cartoon styling — under any circumstances. Return ONLY a JSON object with keys: variation_a, variation_b, variation_c.`;
        const userMsg = `Design concept:
Name: ${concept.conceptName}
Format: ${concept.format}
Art style (USE THIS EXACTLY): ${input.style}
Headline: ${concept.headline ?? "none"}
Subtext: ${concept.subtext ?? "none"}
Color Palette: ${(concept.colorPalette as string[] ?? []).join(", ") || "not specified"}
Layout: ${concept.layoutDescription ?? "not specified"}
Font: ${concept.fontSuggestion ?? "not specified"}`;

        try {
          const promptResult = await invokeLLM({
            messages: [
              { role: "system", content: promptSystem },
              { role: "user", content: userMsg },
            ],
            response_format: { type: "json_object" },
          });
          const promptContent = typeof promptResult.choices[0]?.message?.content === "string"
            ? promptResult.choices[0].message.content : "";
          const parsed = JSON.parse(promptContent);
          const prompts = {
            A: parsed.variation_a ?? parsed.prompt ?? "",
            B: parsed.variation_b ?? "",
            C: parsed.variation_c ?? "",
          };

          const results = await Promise.allSettled(
            (["A", "B", "C"] as const).filter((v) => prompts[v]).map(async (variation) => {
              const img = await generateImage({ prompt: prompts[variation] });
              return { variation, url: img.url ?? null, prompt: prompts[variation] };
            })
          );

          const update: Parameters<typeof updateConceptImages>[1] = {};
          const regenerated: Array<"A" | "B" | "C"> = [];
          for (const r of results) {
            if (r.status !== "fulfilled" || !r.value.url) continue;
            const { variation, url, prompt } = r.value;
            regenerated.push(variation);
            if (variation === "A") { update.imageUrlA = url; update.imagePromptA = prompt; }
            if (variation === "B") { update.imageUrlB = url; update.imagePromptB = prompt; }
            if (variation === "C") { update.imageUrlC = url; update.imagePromptC = prompt; }
          }
          if (regenerated.length === 0) {
            return { success: false, message: "Image generation returned no images." };
          }

          // Overwrite the images (non-null overwrite is allowed by the immutability guard), update
          // the style label, and CLEAR the cached production renders for the regenerated variations
          // so mockups re-process the NEW image instead of serving the old one.
          await updateConceptImages(input.conceptId, update);
          await updateConceptStyle(input.conceptId, input.style);
          await Promise.all(regenerated.map((v) => updateConceptProductionUrl(input.conceptId, v, null)));

          return { success: true, message: `Regenerated ${regenerated.length} image(s) in "${input.style}" style.` };
        } catch (err: any) {
          console.error(`[RegenerateImage] Failed for concept ${input.conceptId}:`, err);
          return { success: false, message: err?.message ?? "Regeneration failed." };
        }
      }),

    exportProduction: protectedProcedure
      .input(z.object({
        conceptId: z.number(),
        variation: z.enum(["A", "B", "C"]),
      }))
      .mutation(async ({ input }) => {
        const concept = await getConceptById(input.conceptId);
        if (!concept) {
          return { success: false, message: "Concept not found.", url: null };
        }

        // Check for cached production URL
        const cachedUrl = input.variation === "A" ? concept.productionUrlA
          : input.variation === "B" ? concept.productionUrlB
          : concept.productionUrlC;

        if (cachedUrl) {
          return { success: true, message: "Production file ready (cached).", url: cachedUrl };
        }

        // Get the source image URL
        const sourceUrl = input.variation === "A" ? concept.imageUrlA
          : input.variation === "B" ? concept.imageUrlB
          : concept.imageUrlC;

        if (!sourceUrl) {
          return { success: false, message: `No image exists for variation ${input.variation}.`, url: null };
        }

        try {
          // v2 pipeline: generate standalone design on magenta BG, chromakey to transparent
          const promptDesc = (input.variation === "A" ? concept.imagePromptA
            : input.variation === "B" ? concept.imagePromptB
            : concept.imagePromptC)
            || `${concept.conceptName || "design"} in ${concept.style || "graphic tee"} style`;

          const url = await processDesignForProduction(
            sourceUrl,
            input.conceptId,
            input.variation,
            promptDesc
          );

          return { success: true, message: "Production file ready.", url };
        } catch (err: any) {
          console.error(`[ProductionExport] Failed for concept ${input.conceptId} variation ${input.variation}:`, err);
          return { success: false, message: err?.message ?? "Export failed.", url: null };
        }
      }),
   }),

  // ─── Health & Self-Healing ──────────────────────────────────────────
  health: router({
    status: publicProcedure.query(async () => {
      return await checkHealth();
    }),

    healingLog: protectedProcedure
      .input(z.object({ limit: z.number().min(1).max(100).default(20) }))
      .query(async ({ ctx }) => {
        const db = await (await import("./db")).getDb();
        if (!db) return [];
        const logs = await db
          .select()
          .from(healingLog)
          .orderBy(desc(healingLog.createdAt))
          .limit(ctx.user ? 20 : 5);
        return logs.map((l: any) => ({
          id: l.id,
          subsystem: l.subsystem,
          issue: l.issue,
          classification: l.classification,
          actionTaken: l.actionTaken,
          result: l.result,
          mttrSeconds: l.mttrSeconds,
          runId: l.runId,
          createdAt: l.createdAt?.toISOString?.() ?? null,
        }));
      }),

    circuits: publicProcedure.query(() => {
      const circuitNames = ["nyt_api", "forum_scraper", "llm", "image_gen", "etsy_api"];
      return circuitNames.map((name) => {
        const state = getCircuitState(name);
        return {
          name,
          isOpen: state.isOpen,
          failures: state.failures,
          lastFailure: state.lastFailure ? new Date(state.lastFailure).toISOString() : null,
          openedAt: state.openedAt ? new Date(state.openedAt).toISOString() : null,
        };
      });
    }),
  }),
});
export type AppRouter = typeof appRouter;
