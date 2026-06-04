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
  recordApprovalSignal,
  recordRejectionSignal,
  updateTrendPatternDtfUrl,
  getStuckProductionPatterns,
  countStuckProductionPatterns,
} from "./nicheHunterDb";
import { runNicheHunterScan } from "./nicheHunter";
import { processPatternProduction } from "./patternProductionProcessor";
import { getWorkspaceById } from "./workspaceDb";
import { createConceptFromPattern } from "./db";
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

export const nicheHunterRouter = router({
  /**
   * Trigger a new niche hunter scan for the active workspace.
   */
  triggerScan: protectedProcedure
    .input(z.object({ workspaceId: z.string() }))
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
        return { scanId: latest.id, alreadyRunning: true };
      }

      const scanRun = await createScanRun(input.workspaceId);

      // Scraper-based pipeline: no Etsy API key needed
      runNicheHunterScan(workspace, scanRun.id).catch((err) =>
        console.error("[NicheHunter] Scan failed:", err)
      );

      return { scanId: scanRun.id, alreadyRunning: false };
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
   * Regenerate the productionDesignUrl for an existing pattern.
   * Calls processPatternProduction with the pattern's stored sourceImageUrl and promptDescription.
   * This is the user-facing "regenerate" action for stale or failed production images.
   */
  regenerateProductionImage: protectedProcedure
    .input(z.object({ patternId: z.string(), workspaceId: z.string() }))
    .mutation(async ({ input }) => {
      const patterns = await getTrendPatternsByWorkspace(input.workspaceId);
      const pattern = patterns.find((p) => p.id === input.patternId);
      if (!pattern) throw new TRPCError({ code: "NOT_FOUND", message: "Pattern not found" });
      if (!pattern.sourceImageUrl) throw new TRPCError({ code: "BAD_REQUEST", message: "No source image URL" });
      const promptDesc = (pattern as any).promptDescription ?? pattern.adaptedConcept ?? "";
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
   * Picks ONE stuck pattern (has sourceImageUrl, no productionDesignUrl) and runs
   * processPatternProduction on it synchronously within the request lifetime.
   * Returns { processed: patternId | null, remaining: number }.
   *
   * The frontend polls this every 15s while remaining > 0, draining the queue
   * one image per request — each call completes well within the 180s Cloud Run timeout.
   */
  retryStuckPatterns: protectedProcedure
    .input(z.object({ workspaceId: z.string() }))
    .mutation(async ({ input }) => {
      const stuck = await getStuckProductionPatterns(input.workspaceId, 1);
      if (stuck.length === 0) {
        return { processed: null, remaining: 0 };
      }
      const pattern = stuck[0];
      const promptDesc = (pattern as any).promptDescription ?? pattern.adaptedConcept ?? "";
      try {
        await processPatternProduction(
          pattern.id,
          input.workspaceId,
          pattern.sourceImageUrl!,
          promptDesc
        );
        console.log(`[retryStuckPatterns] ✅ Processed pattern ${pattern.id}: ${pattern.adaptedConcept?.slice(0, 60)}`);
      } catch (err) {
        console.error(`[retryStuckPatterns] ❌ Failed pattern ${pattern.id}:`, err instanceof Error ? err.message : err);
        // Don't throw — return remaining count so frontend keeps polling
      }
      const remaining = await countStuckProductionPatterns(input.workspaceId);
      return { processed: pattern.id, remaining };
    }),
});
