/**
 * Niche Hunter tRPC Router — Phase E + Style-Faithful Pipeline
 *
 * 7 procedures:
 *   triggerScan, getScanStatus, getPatterns,
 *   approvePattern (with reason+tags + deferred DTF trigger),
 *   dismissPattern (with reason+tags),
 *   getStylePreferences (computed from approval/rejection history),
 *   flagEditModeResult (user flags edit_source result as bad → retry in style_reference)
 */
import { z } from "zod";
import { protectedProcedure, router } from "./_core/trpc";
import { TRPCError } from "@trpc/server";
import {
  createScanRun,
  getScanRunById,
  getLatestScanRun,
  getTrendPatternsByWorkspace,
  updateTrendPatternStatus,
  updateTrendPatternName,
  recordApprovalSignal,
  recordRejectionSignal,
  updateTrendPatternDtfUrl,
  updateTrendPatternProductionUrl,
  getStuckProductionPatterns,
  countStuckProductionPatterns,
  failDeadProductionPatterns,
  recordProductionFailure,
  claimProductionPattern,
  updateScanRun,
  updateTrendPatternChosenConcept,
} from "./nicheHunterDb";
import { runNicheHunterScan } from "./nicheHunter";
import { processPatternProduction } from "./patternProductionProcessor";
import { getWorkspaceById } from "./workspaceDb";
import { createConceptFromPattern, updateConceptNameByNichePatternId } from "./db";
import { computeSignalWeights } from "./signalWeights";

// Approval tag options (shown as chips in UI)
const APPROVAL_TAGS = [
  "great_style",
  "perfect_subject",
  "strong_humor",
  "niche_authentic",
  "clean_composition",
  "love_colors",
] as const;

// Rejection tag options
const REJECTION_TAGS = [
  "wrong_style",
  "bad_subject",
  "weak_humor",
  "off_brand",
  "poor_composition",
  "bad_colors",
  "too_generic",
  "transfer_failed",
] as const;

// Watchdog: a production pattern (sourceImageUrl, no productionDesignUrl) stuck longer than
// this is treated as abandoned (Cloud Run killed the generation mid-flight — that path never
// throws, so the attempt-based retry cap can't fire). Generous vs. the real ~30-60s production
// time + a few minutes of queue/council. Reaped on the read path (getPatterns) + before retry.
const PRODUCTION_DEAD_THRESHOLD_MS = 15 * 60 * 1000; // 15 minutes

export const nicheHunterRouter = router({
  /**
   * Trigger a new niche hunter scan for the active workspace.
   */
  triggerScan: protectedProcedure
    .input(z.object({
      workspaceId: z.string(),
      // PO Option C: 'auto' (brain picks + generates) or 'curated' (brain proposes
      // concept options per source, human picks before any image is generated).
      mode: z.enum(["auto", "curated"]).default("auto"),
    }))
    .mutation(async ({ input }) => {
      const workspace = await getWorkspaceById(input.workspaceId);
      if (!workspace) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Workspace not found" });
      }
      if (workspace.workspaceType !== "niche_hunter") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Niche Hunter is only available for niche_hunter workspaces",
        });
      }

      const latest = await getLatestScanRun(input.workspaceId);
      if (latest?.status === "running") {
        // Dead-scan watchdog: Cloud Run kills containers after ~10 min idle. A scan
        // row stuck at status='running' for much longer than any realistic scan time
        // means the original runNicheHunterScan handler was killed mid-execution —
        // the row stays "running" forever and blocks every future triggerScan.
        // Manus PO confirmed a case where the UI was stuck on "Scanning..." for
        // 4+ hours because of this. Self-heal: mark the dead row failed and proceed.
        const SCAN_DEAD_THRESHOLD_MS = 15 * 60 * 1000; // 15 minutes — generous vs. realistic ~3-4min scan time
        const ageMs = Date.now() - latest.createdAt.getTime();
        if (ageMs > SCAN_DEAD_THRESHOLD_MS) {
          const ageMin = Math.round(ageMs / 60000);
          console.warn(`[triggerScan] Scan ${latest.id} stuck at status='running' for ${ageMin}min — exceeds ${SCAN_DEAD_THRESHOLD_MS / 60000}min dead threshold. Marking failed and starting fresh.`);
          await updateScanRun(latest.id, {
            status: "failed",
            errorLog: `Scan abandoned by watchdog — running for ${ageMin}min exceeds dead threshold (likely Cloud Run container killed mid-execution).`,
            completedAt: new Date(),
          });
        } else {
          return { scanId: latest.id, alreadyRunning: true };
        }
      }

      const scanRun = await createScanRun(input.workspaceId, input.mode);

      // Scraper-based pipeline: no Etsy API key needed. conceptMode controls whether
      // the scan auto-generates (auto) or proposes concept options for the human (curated).
      runNicheHunterScan(workspace, scanRun.id, undefined, input.mode).catch((err) =>
        console.error("[NicheHunter] Scan failed:", err)
      );

      return { scanId: scanRun.id, alreadyRunning: false, mode: input.mode };
    }),

  /**
   * Poll scan status by scanId, or get latest scan for a workspace.
   */
  getScanStatus: protectedProcedure
    .input(z.object({ scanId: z.string().optional(), workspaceId: z.string() }))
    .query(async ({ input }) => {
      const run = input.scanId
        ? await getScanRunById(input.scanId)
        : await getLatestScanRun(input.workspaceId);

      if (!run) {
        return { status: "none" as const, progress: 0, patternsFound: 0, scanId: null };
      }

      return {
        status: run.status,
        progress: run.progress,
        patternsFound: run.patternsFound,
        scanId: run.id,
        errorLog: run.errorLog ?? null,
        completedAt: run.completedAt ? run.completedAt.getTime() : null,
        createdAt: run.createdAt.getTime(),
        searchLog: run.searchLog ?? [],
      };
    }),

  /**
   * Get trend patterns for a workspace, optionally filtered by status.
   */
  getPatterns: protectedProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        status: z.enum(["discovered", "approved", "dismissed"]).optional(),
      })
    )
    .query(async ({ input }) => {
      // WATCHDOG ON THE READ PATH: the page polls getPatterns continuously even when no
      // scan/retry is triggered. Reap DEAD production patterns here (stuck > threshold with
      // no output → Cloud Run killed mid-generation, which never throws so the attempt-based
      // cap can't fire) so the UI stops showing "Generating…" forever. Non-blocking.
      try {
        await failDeadProductionPatterns(input.workspaceId, PRODUCTION_DEAD_THRESHOLD_MS);
      } catch (err) {
        console.warn("[getPatterns] dead-pattern watchdog failed (non-blocking):", err);
      }
      return getTrendPatternsByWorkspace(input.workspaceId, input.status);
    }),

  /**
   * Approve a pattern — records signal (reason + tags), creates Concept Library entry,
   * and triggers deferred DTF extraction in the background.
   */
  approvePattern: protectedProcedure
    .input(
      z.object({
        patternId: z.string(),
        workspaceId: z.string(),
        reason: z.string().max(500).optional(),
        tags: z.array(z.enum(APPROVAL_TAGS)).default([]),
      })
    )
    .mutation(async ({ input }) => {
      // 1. Mark approved
      await updateTrendPatternStatus(input.patternId, "approved");

      // 2. Record approval signal
      await recordApprovalSignal(
        input.patternId,
        input.reason ?? null,
        input.tags
      );

      // 3. Fetch full pattern row to create concept
      const patterns = await getTrendPatternsByWorkspace(input.workspaceId, "approved");
      const pattern = patterns.find((p) => p.id === input.patternId);
      if (!pattern) {
        return { success: true, conceptId: null };
      }

      const conceptId = await createConceptFromPattern(pattern, input.workspaceId);

      // 4. Deferred DTF extraction — fire and forget
      // v2 path: use productionDesignUrl (transparent PNG) — skip flood-fill
      // Legacy path: use previewImageUrl (shirt photo) — run flood-fill
      const dtfSourceUrl = pattern.productionDesignUrl || pattern.previewImageUrl;
      const isAlreadyTransparent = !!pattern.productionDesignUrl;
      if (dtfSourceUrl && !pattern.dtfImageUrl) {
        void (async () => {
          try {
            const { processPatternForDtf } = await import("./patternDtfProcessor");
            const dtfUrl = await processPatternForDtf(dtfSourceUrl, isAlreadyTransparent);
            if (dtfUrl) {
              await updateTrendPatternDtfUrl(input.patternId, dtfUrl);
              console.log(`[NicheHunter] DTF extraction complete for pattern ${input.patternId} (${isAlreadyTransparent ? 'v2 transparent' : 'legacy'})`);
            }
          } catch (err) {
            console.warn(`[NicheHunter] DTF extraction failed for pattern ${input.patternId}:`, err);
          }
        })();
      }

      return { success: true, conceptId };
    }),

  /**
   * Dismiss a pattern — records rejection signal (reason + tags).
   */
  /** Rename a niche pattern (PO 2026-06-12) — anywhere it appears. */
  renamePattern: protectedProcedure
    .input(z.object({ patternId: z.string(), name: z.string().min(1).max(120) }))
    .mutation(async ({ input }) => {
      await updateTrendPatternName(input.patternId, input.name.trim());
      // Propagate to the linked design concept so the Mockups/Listings pickers show the new short name,
      // not the stale long Etsy title (PO 2026-06-16).
      await updateConceptNameByNichePatternId(input.patternId, input.name.trim());
      return { success: true };
    }),

  dismissPattern: protectedProcedure
    .input(
      z.object({
        patternId: z.string(),
        reason: z.string().max(500).optional(),
        tags: z.array(z.enum(REJECTION_TAGS)).default([]),
      })
    )
    .mutation(async ({ input }) => {
      await updateTrendPatternStatus(input.patternId, "dismissed");
      await recordRejectionSignal(
        input.patternId,
        input.reason ?? null,
        input.tags
      );
      return { success: true };
    }),

  /**
   * Get style preferences summary computed from approval/rejection history.
   * Returns tag weights and totals for the "Style Preferences" card.
   */
  getStylePreferences: protectedProcedure
    .input(z.object({ workspaceId: z.string() }))
    .query(async ({ input }) => {
      const patterns = await getTrendPatternsByWorkspace(input.workspaceId);
      return computeSignalWeights(patterns);
    }),

  /**
   * Flag an edit_source result as bad — the user wants to retry in style_reference mode.
   * Updates adaptationMode to "style_reference" and clears the current previewImageUrl
   * so the UI shows a "regenerating" state. Actual regeneration is triggered client-side
   * via a separate mutation (not implemented here — future enhancement).
   */
  flagEditModeResult: protectedProcedure
    .input(
      z.object({
        patternId: z.string(),
        workspaceId: z.string(),
      })
    )
    .mutation(async ({ input }) => {
      const { updateTrendPatternStyleData } = await import("./nicheHunterDb");
      await updateTrendPatternStyleData(input.patternId, {
        adaptationMode: "style_reference_flagged",
      });
      return { success: true, message: "Pattern flagged for style_reference retry" };
    }),

  /**
   * Curated mode (PO Option C): the human picked one of the brain's proposed concept
   * options. Record it, then run production seeded with that concept (the brain writes
   * the edit prompt FOR the chosen concept instead of re-choosing).
   *
   * Cloud-Run-safe: like regenerateProductionImage, this runs synchronously; if it 524s
   * the chosenConcept is already saved and productionDesignUrl stays null, so
   * retryStuckPatterns picks it up — BUT retryStuckPatterns calls processPatternProduction
   * WITHOUT the chosen concept. To keep curated picks faithful on retry, the chosenConcept
   * is persisted and re-read by the retry path (see retryStuckPatterns).
   */
  chooseConceptAndGenerate: protectedProcedure
    .input(z.object({
      patternId: z.string(),
      workspaceId: z.string(),
      chosenConcept: z.string().min(1).max(500),
    }))
    .mutation(async ({ input }) => {
      const patterns = await getTrendPatternsByWorkspace(input.workspaceId);
      const pattern = patterns.find((p) => p.id === input.patternId);
      if (!pattern) throw new TRPCError({ code: "NOT_FOUND", message: "Pattern not found" });
      if (!pattern.sourceImageUrl) throw new TRPCError({ code: "BAD_REQUEST", message: "No source image URL" });

      // Persist the choice first so a 524 mid-generation doesn't lose it (retry re-reads it).
      await updateTrendPatternChosenConcept(input.patternId, input.chosenConcept);

      const result = await processPatternProduction(
        input.patternId,
        input.workspaceId,
        pattern.sourceImageUrl,
        pattern.adaptedConcept ?? "",
        input.chosenConcept,
      );
      return result;
    }),

  /**
   * Regenerate the productionDesignUrl for an existing pattern.
   *
   * Cloud-Run-safe pattern: NULL OUT productionDesignUrl first (marks the pattern as
   * "needs regen"), THEN call processPatternProduction synchronously. If sync completes,
   * processPatternProduction writes the new URL — done. If sync hits Cloudflare's ~100s
   * edge timeout (524 to client), the productionDesignUrl stays null in the DB, and
   * `retryStuckPatterns` (which the frontend already polls) will pick it up and finish
   * the regen within its own request lifetime (which holds the Cloud Run container alive).
   *
   * Why the previous fire-and-forget pattern failed: Cloud Run kills the container when
   * the request handler returns and no other requests are in-flight. The `void async`
   * background work was killed before completion. The retryStuckPatterns mirror reuses
   * existing infra and works because each retry call IS a real request.
   */
  regenerateProductionImage: protectedProcedure
    .input(z.object({ patternId: z.string(), workspaceId: z.string() }))
    .mutation(async ({ input }) => {
      const patterns = await getTrendPatternsByWorkspace(input.workspaceId);
      const pattern = patterns.find((p) => p.id === input.patternId);
      if (!pattern) throw new TRPCError({ code: "NOT_FOUND", message: "Pattern not found" });
      if (!pattern.sourceImageUrl) throw new TRPCError({ code: "BAD_REQUEST", message: "No source image URL" });
      const promptDesc = (pattern as any).promptDescription ?? pattern.adaptedConcept ?? "";

      // Mark for regen FIRST so retryStuckPatterns will pick it up if the sync call 524s.
      await updateTrendPatternProductionUrl(input.patternId, null);

      // Sync call — likely completes if reasoning_effort+edit total <100s. On 524 the
      // client sees an error but the null in DB ensures retryStuckPatterns recovers.
      const result = await processPatternProduction(
        input.patternId,
        input.workspaceId,
        pattern.sourceImageUrl,
        promptDesc
      );
      return result;
    }),

  /**
   * Cloud-Run-safe production image retry.
   * Picks up to RETRY_BATCH_SIZE stuck patterns (have sourceImageUrl, no
   * productionDesignUrl) and runs processPatternProduction on each CONCURRENTLY
   * within the request lifetime.
   * Returns { processed: patternId | null, remaining: number }.
   *
   * The frontend polls this every 15s while remaining > 0. Bumping the batch from
   * 1 to 3 drains 20 stuck patterns in ~7 calls instead of ~20 — biggest single
   * lever for total scan→visible-mockup wall-clock. Sized so 3 concurrent gpt-image-1
   * jobs at quality=medium (Step 1) + quality=high (Step 2) still fit comfortably
   * inside Cloud Run's 180s sync request timeout.
   */
  retryStuckPatterns: protectedProcedure
    .input(z.object({ workspaceId: z.string() }))
    .mutation(async ({ input }) => {
      // Reap DEAD patterns first (age-based) so we never re-retry one that's been stuck
      // past the threshold (it would just re-hang and re-die). Only fresh stuck ones retry.
      try {
        await failDeadProductionPatterns(input.workspaceId, PRODUCTION_DEAD_THRESHOLD_MS);
      } catch (err) {
        console.warn("[retryStuckPatterns] dead-pattern reap failed (non-blocking):", err);
      }
      const RETRY_BATCH_SIZE = 3;
      const stuck = await getStuckProductionPatterns(input.workspaceId, RETRY_BATCH_SIZE);
      if (stuck.length === 0) {
        return { processed: null, remaining: 0 };
      }
      // Process concurrently — each pattern's failure is logged independently and
      // does not abort the others. No throw out — frontend keeps polling on remaining>0.
      // On failure we increment productionAttempts; after MAX_PRODUCTION_ATTEMPTS the
      // pattern is auto-dismissed (rejectionTags=['transfer_failed']) so it stops
      // re-entering the queue forever. Fixes the 4-hour stuck case Manus PO confirmed.
      //
      // Each pattern is ATOMICALLY CLAIMED before processing. The frontend polls every
      // 15s but each call takes minutes, so polls overlap; without the claim, two calls
      // grab the same pattern and run it 2-3x (duplicate gpt-image-1 cost + contradictory
      // validationReport-vs-status rows, PO-confirmed 2026-06-07). claimProductionPattern
      // is a conditional UPDATE — only one concurrent caller wins; the rest skip.
      const MAX_PRODUCTION_ATTEMPTS = 3;
      const now = new Date();
      const processedIds: string[] = [];
      await Promise.all(stuck.map(async (pattern) => {
        const won = await claimProductionPattern(pattern.id, now);
        if (!won) {
          console.log(`[retryStuckPatterns] ⏭️  Pattern ${pattern.id} already claimed by another worker — skipping`);
          return;
        }
        processedIds.push(pattern.id);
        const promptDesc = (pattern as any).promptDescription ?? pattern.adaptedConcept ?? "";
        try {
          // Pass chosenConcept so curated picks stay faithful if the original
          // chooseConceptAndGenerate call 524'd and this retry finishes the job.
          await processPatternProduction(
            pattern.id,
            input.workspaceId,
            pattern.sourceImageUrl!,
            promptDesc,
            pattern.chosenConcept ?? ""
          );
          console.log(`[retryStuckPatterns] ✅ Processed pattern ${pattern.id}: ${pattern.adaptedConcept?.slice(0, 60)}`);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          console.error(`[retryStuckPatterns] ❌ Failed pattern ${pattern.id}: ${errMsg}`);
          try {
            const { attempts, dismissed } = await recordProductionFailure(
              pattern.id,
              errMsg,
              MAX_PRODUCTION_ATTEMPTS
            );
            if (dismissed) {
              console.error(`[retryStuckPatterns] 💀 Pattern ${pattern.id} AUTO-DISMISSED after ${attempts} failed attempts (max=${MAX_PRODUCTION_ATTEMPTS})`);
            } else {
              console.warn(`[retryStuckPatterns] ⏳ Pattern ${pattern.id} attempt ${attempts}/${MAX_PRODUCTION_ATTEMPTS} — will retry on next poll`);
            }
          } catch (bookkeepErr) {
            console.error(`[retryStuckPatterns] failed to record retry count for ${pattern.id}:`, bookkeepErr);
          }
        }
      }));
      const remaining = await countStuckProductionPatterns(input.workspaceId);
      // `processed` = first pattern we actually claimed+processed this call (null if all
      // were already claimed by overlapping workers). Frontend uses it only as a liveness
      // signal; remaining drives whether it keeps polling.
      return { processed: processedIds[0] ?? null, remaining };
    }),
});
