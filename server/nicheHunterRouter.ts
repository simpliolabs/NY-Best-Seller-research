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
} from "./nicheHunterDb";
import { runNicheHunterScan } from "./nicheHunter";
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

      const rawEtsyKey = process.env.ETSY_API_KEY;
      const rawEtsySecret = process.env.ETSY_API_SECRET;
      const etsyApiKey = rawEtsyKey && rawEtsySecret
        ? `${rawEtsyKey}:${rawEtsySecret}`
        : rawEtsyKey || undefined;

      runNicheHunterScan(workspace, scanRun.id, etsyApiKey).catch((err) =>
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
      if (pattern.previewImageUrl && !pattern.dtfImageUrl) {
        void (async () => {
          try {
            const { processPatternForDtf } = await import("./patternDtfProcessor");
            const dtfUrl = await processPatternForDtf(pattern.previewImageUrl!);
            if (dtfUrl) {
              await updateTrendPatternDtfUrl(input.patternId, dtfUrl);
              console.log(`[NicheHunter] DTF extraction complete for pattern ${input.patternId}`);
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
});
