/**
 * Niche Hunter DB helpers — Phase E
 * Karpathy P2: only what the router and engine need. No speculative helpers.
 */
import { eq, and, desc, or, isNull, lt } from "drizzle-orm";
import { getDb } from "./db";
import { nicheScanRuns, trendPatterns } from "../drizzle/schema";
import type { NicheScanRun, TrendPattern, InsertTrendPattern } from "../drizzle/schema";
import { nanoid } from "nanoid";

// ─── Scan Runs ────────────────────────────────────────────────────────────────

export async function createScanRun(workspaceId: string): Promise<NicheScanRun> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const id = nanoid();
  await db.insert(nicheScanRuns).values({ id, workspaceId });
  const row = await db.select().from(nicheScanRuns).where(eq(nicheScanRuns.id, id)).limit(1);
  if (!row[0]) throw new Error("Failed to create scan run");
  return row[0];
}

export async function updateScanRun(
  id: string,
  fields: Partial<Pick<NicheScanRun, "status" | "progress" | "patternsFound" | "errorLog" | "completedAt" | "searchLog">>
): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.update(nicheScanRuns).set(fields).where(eq(nicheScanRuns.id, id));
}

export async function getScanRunById(id: string): Promise<NicheScanRun | null> {
  const db = await getDb();
  if (!db) return null;
  const rows = await db.select().from(nicheScanRuns).where(eq(nicheScanRuns.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function getLatestScanRun(workspaceId: string): Promise<NicheScanRun | null> {
  const db = await getDb();
  if (!db) return null;
  const rows = await db
    .select()
    .from(nicheScanRuns)
    .where(eq(nicheScanRuns.workspaceId, workspaceId))
    .orderBy(desc(nicheScanRuns.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

// ─── Trend Patterns ───────────────────────────────────────────────────────────

export async function createTrendPattern(
  data: Omit<InsertTrendPattern, "id">
): Promise<TrendPattern> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const id = nanoid();
  await db.insert(trendPatterns).values({ ...data, id });
  const row = await db.select().from(trendPatterns).where(eq(trendPatterns.id, id)).limit(1);
  if (!row[0]) throw new Error("Failed to create trend pattern");
  return row[0];
}

export async function getTrendPatternsByWorkspace(
  workspaceId: string,
  status?: "discovered" | "approved" | "dismissed"
): Promise<TrendPattern[]> {
  const db = await getDb();
  if (!db) return [];
  const conditions = status
    ? and(eq(trendPatterns.workspaceId, workspaceId), eq(trendPatterns.status, status))
    : eq(trendPatterns.workspaceId, workspaceId);
  return db
    .select()
    .from(trendPatterns)
    .where(conditions)
    .orderBy(desc(trendPatterns.createdAt));
}

export async function updateTrendPatternStatus(
  id: string,
  status: "discovered" | "approved" | "dismissed"
): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.update(trendPatterns).set({ status }).where(eq(trendPatterns.id, id));
}

export async function updateTrendPatternImage(
  id: string,
  previewImageUrl: string
): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.update(trendPatterns).set({ previewImageUrl }).where(eq(trendPatterns.id, id));
}

export async function updateTrendPatternScore(
  id: string,
  score: number,
  rankReasoning: string
): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.update(trendPatterns).set({ score, rankReasoning }).where(eq(trendPatterns.id, id));
}

/**
 * Update style-faithful pipeline fields on a trend pattern.
 * Used by nicheHunter.ts after style extraction and mode selection.
 */
export async function updateTrendPatternStyleData(
  id: string,
  fields: {
    sourceStyleJson?: Record<string, unknown> | null;
    adaptationMode?: string;
  }
): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.update(trendPatterns).set(fields).where(eq(trendPatterns.id, id));
}

/**
 * Record approval signal: reason, tags, and timestamp.
 */
export async function recordApprovalSignal(
  id: string,
  reason: string | null,
  tags: string[]
): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.update(trendPatterns)
    .set({ approvalReason: reason, approvalTags: tags, approvedAt: new Date() })
    .where(eq(trendPatterns.id, id));
}

/**
 * Record rejection signal: reason, tags, and timestamp.
 */
export async function recordRejectionSignal(
  id: string,
  reason: string | null,
  tags: string[]
): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.update(trendPatterns)
    .set({ rejectionReason: reason, rejectionTags: tags, dismissedAt: new Date() })
    .where(eq(trendPatterns.id, id));
}

/**
 * Update the dtfImageUrl for a pattern after post-approval production processing.
 */
export async function updateTrendPatternDtfUrl(
  id: string,
  dtfImageUrl: string
): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.update(trendPatterns).set({ dtfImageUrl }).where(eq(trendPatterns.id, id));
}

/**
 * Overwrite a pattern's adaptedConcept with the production brain's plain-English
 * concept summary, so the CARD matches the actual generated IMAGE. The scan-time
 * brain (deconstructAndAdapt) writes adaptedConcept first for ranking/early display,
 * but it's a guess made before the image exists (it produced generic boilerplate like
 * "T-Rex/Llama/Octopus" while the image was capybaras). The production brain
 * (nicheExpertPlan) is the one that actually looks at the image and makes the design,
 * so its conceptSummary is the source of truth for display. PO-confirmed 2026-06-08.
 */
export async function updateTrendPatternConcept(
  id: string,
  adaptedConcept: string
): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.update(trendPatterns).set({ adaptedConcept }).where(eq(trendPatterns.id, id));
}

/**
 * Persist the vision-LLM validation report for a pattern. Run AFTER assertTransparentPng
 * and BEFORE storagePut so we can auto-dismiss bad outputs without writing them as
 * approved-looking assets. See ValidationReport in patternProductionProcessor.ts.
 */
export async function updateTrendPatternValidationReport(
  id: string,
  report: {
    nicheRelevance: number;
    matchesPlan: boolean;
    textInImage: string;
    textMatchesPlan: boolean;
    hasTypo: boolean;
    shouldShip: boolean;
    reasoning: string;
  }
): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.update(trendPatterns).set({ validationReport: report }).where(eq(trendPatterns.id, id));
}

/**
 * Update the per-shirt-color preview gallery for a pattern. Each entry is one
 * mockup template's composite preview, halftoned for that template's shirt color.
 * PO insight: halftone is shirt-color-dependent, so each shirt gets its own preview.
 * Legacy previewImageUrl stays populated separately for backward UI compat.
 */
export async function updateTrendPatternPreviewUrls(
  id: string,
  previewImageUrls: Array<{ templateId: string; colorHex: string; colorName: string; previewUrl: string }>
): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.update(trendPatterns).set({ previewImageUrls }).where(eq(trendPatterns.id, id));
}

/**
 * Update the productionDesignUrl for a pattern — the canonical transparent PNG asset.
 */
export async function updateTrendPatternProductionUrl(
  id: string,
  productionDesignUrl: string | null
): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.update(trendPatterns).set({ productionDesignUrl }).where(eq(trendPatterns.id, id));
}

/**
 * Production-retry bookkeeping.
 *
 * Increment the pattern's productionAttempts counter. If it reaches `maxAttempts`,
 * auto-dismiss the pattern (status=dismissed, rejectionReason includes the last
 * error, rejectionTags=['transfer_failed']) so retryStuckPatterns stops re-picking
 * it from the queue. Otherwise leave status='discovered' and the next poll will
 * try again.
 *
 * WHY THIS EXISTS:
 * retryStuckPatterns previously logged on failure but never gave up. A permanently
 * failing pattern (bad source URL, brain crash on weird source, persistent
 * gpt-image-1 5xx, etc.) re-entered the queue every 15s forever. Manus PO confirmed
 * a 4-hour stuck case where one bad source spun the loop ~960 times.
 *
 * Returns the new attempt count and whether the pattern got auto-dismissed.
 */
export async function recordProductionFailure(
  id: string,
  errorMessage: string,
  maxAttempts: number = 3
): Promise<{ attempts: number; dismissed: boolean }> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const rows = await db.select().from(trendPatterns).where(eq(trendPatterns.id, id)).limit(1);
  const current = rows[0];
  if (!current) return { attempts: 0, dismissed: false };
  const attempts = (current.productionAttempts ?? 0) + 1;
  const trimmedErr = errorMessage.length > 280 ? errorMessage.slice(0, 277) + "..." : errorMessage;
  if (attempts >= maxAttempts) {
    // Give up — auto-dismiss so the retry loop stops re-picking
    await db.update(trendPatterns)
      .set({
        productionAttempts: attempts,
        status: "dismissed",
        rejectionReason: `Production failed after ${attempts} attempts. Last error: ${trimmedErr}`,
        rejectionTags: ["transfer_failed"],
        dismissedAt: new Date(),
      })
      .where(eq(trendPatterns.id, id));
    return { attempts, dismissed: true };
  }
  // Not yet — bump the counter and CLEAR the claim so the next poll can retry
  // immediately (the 5-min staleness window only matters for crash recovery; on a
  // clean failure we want the next 15s poll to pick it back up).
  await db.update(trendPatterns)
    .set({ productionAttempts: attempts, claimedAt: null })
    .where(eq(trendPatterns.id, id));
  return { attempts, dismissed: false };
}

/**
 * How long a production claim is held before it's considered stale and re-claimable.
 * Covers the crash-recovery case: if a retryStuckPatterns worker is killed mid-process
 * (Cloud Run container scale-down) it never clears its claim, so after this window the
 * pattern becomes claimable again. On a clean failure recordProductionFailure clears
 * the claim immediately, so this only bites on hard crashes.
 */
const CLAIM_STALE_MS = 5 * 60 * 1000;

/**
 * Atomically claim a stuck pattern for production processing.
 *
 * Single conditional UPDATE: set claimedAt=now WHERE id matches AND the pattern is
 * currently unclaimed (claimedAt NULL or older than CLAIM_STALE_MS). InnoDB serializes
 * row-level UPDATEs, so of two concurrent claimers exactly one matches the WHERE and
 * gets affectedRows=1; the other sees the fresh claimedAt and gets affectedRows=0.
 * Because the new timestamp always differs from the prior value, "matched" implies
 * "changed" — affectedRows===1 reliably signals a won claim under any mysql2 flag.
 *
 * Returns true if THIS caller won the claim (and must process the pattern), false if
 * another concurrent caller already holds it (skip).
 *
 * Fixes the duplicate-processing race: overlapping retryStuckPatterns polls used to
 * grab the same pattern and run it 2-3x (duplicate gpt-image-1 cost + contradictory
 * validationReport-vs-status rows). PO-confirmed 2026-06-07.
 */
export async function claimProductionPattern(id: string, now: Date): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  const staleCutoff = new Date(now.getTime() - CLAIM_STALE_MS);
  const res = await db
    .update(trendPatterns)
    .set({ claimedAt: now })
    .where(
      and(
        eq(trendPatterns.id, id),
        or(isNull(trendPatterns.claimedAt), lt(trendPatterns.claimedAt, staleCutoff))
      )
    );
  // mysql2 returns [ResultSetHeader, FieldPacket[]]; ResultSetHeader.affectedRows
  const affected = (res as unknown as Array<{ affectedRows?: number }>)?.[0]?.affectedRows ?? 0;
  return affected === 1;
}

/**
 * Get patterns that have a sourceImageUrl but no productionDesignUrl.
 * Used by the retry endpoint to process stuck production jobs one at a time.
 * Returns oldest-first so earlier scans are resolved before newer ones.
 *
 * Excludes patterns with a FRESH claim (claimedAt within CLAIM_STALE_MS) so concurrent
 * retryStuckPatterns polls don't even surface an in-flight pattern as a candidate. This
 * narrows the race window; claimProductionPattern() is the actual atomic guard.
 */
export async function getStuckProductionPatterns(
  workspaceId: string,
  limit = 1
): Promise<TrendPattern[]> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db
    .select()
    .from(trendPatterns)
    .where(eq(trendPatterns.workspaceId, workspaceId))
    .orderBy(desc(trendPatterns.createdAt));
  const staleCutoffMs = Date.now() - CLAIM_STALE_MS;
  const isFreshlyClaimed = (r: TrendPattern) =>
    r.claimedAt != null && new Date(r.claimedAt).getTime() >= staleCutoffMs;
  // Filter in JS: has sourceImageUrl but no productionDesignUrl
  // Exclude dismissed: auto-dismissed-on-no-fit patterns intentionally have null
  // productionDesignUrl and must NOT be re-picked (would cause an infinite re-process loop).
  // Exclude freshly-claimed: another worker is processing it right now.
  return rows
    .filter(r => r.sourceImageUrl && !r.productionDesignUrl && r.status !== "dismissed" && !isFreshlyClaimed(r))
    .slice(0, limit);
}

/**
 * Count patterns that have a sourceImageUrl but no productionDesignUrl.
 */
export async function countStuckProductionPatterns(
  workspaceId: string
): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const rows = await db
    .select()
    .from(trendPatterns)
    .where(eq(trendPatterns.workspaceId, workspaceId));
  return rows.filter(r => r.sourceImageUrl && !r.productionDesignUrl && r.status !== "dismissed").length;
}

/**
 * Get all approved patterns that have a previewImageUrl but no dtfImageUrl.
 * Used by the deferred DTF extraction trigger.
 */
export async function getApprovedPatternsNeedingDtf(
  workspaceId: string
): Promise<TrendPattern[]> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db
    .select()
    .from(trendPatterns)
    .where(
      and(
        eq(trendPatterns.workspaceId, workspaceId),
        eq(trendPatterns.status, "approved")
      )
    );
  // Filter in JS: dtfImageUrl is null/undefined but previewImageUrl exists
  return rows.filter(r => r.previewImageUrl && !r.dtfImageUrl);
}
