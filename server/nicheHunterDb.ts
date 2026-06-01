/**
 * Niche Hunter DB helpers — Phase E
 * Karpathy P2: only what the router and engine need. No speculative helpers.
 */
import { eq, and, desc } from "drizzle-orm";
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
  fields: Partial<Pick<NicheScanRun, "status" | "progress" | "patternsFound" | "errorLog" | "completedAt">>
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
