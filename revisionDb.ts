/**
 * Revision DB helpers — Phase G
 * CRUD for design_revisions table.
 * Karpathy: plain functions, no class, no speculative abstractions.
 */
import { eq, and, desc, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { getDb } from "./db";
import { designRevisions } from "../drizzle/schema";
import type { DesignRevision } from "../drizzle/schema";

/** Insert a new revision record */
export async function insertRevision(data: {
  id: string;
  conceptId: number;
  variationKey: string;
  iterationNumber: number;
  instruction: string | null;
  referenceImageUrl: string | null;
  resultImageUrl: string;
  accepted?: boolean;
}): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");
  await db.insert(designRevisions).values({
    id: data.id,
    conceptId: data.conceptId,
    variationKey: data.variationKey,
    iterationNumber: data.iterationNumber,
    instruction: data.instruction,
    referenceImageUrl: data.referenceImageUrl,
    resultImageUrl: data.resultImageUrl,
    accepted: data.accepted ?? false,
  });
}

/** Get all revisions for a concept+variation, newest first */
export async function getRevisionsByConceptVariation(
  conceptId: number,
  variationKey: string
): Promise<DesignRevision[]> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");
  return db
    .select()
    .from(designRevisions)
    .where(
      and(
        eq(designRevisions.conceptId, conceptId),
        eq(designRevisions.variationKey, variationKey)
      )
    )
    .orderBy(desc(designRevisions.iterationNumber));
}

/** Generation history is stored in this table under a sentinel variationKey. "H" never collides
 *  with the real A/B/C variations the Design Studio edits, and varchar(1) only fits a single char. */
export const HISTORY_KEY = "H";

/** Snapshot a design URL into a concept's generation history (sentinel "H" key), deduped by URL so
 *  the same design never stacks up. Call BEFORE overwriting imageUrlA so nothing is ever lost. */
export async function snapshotGenerationToHistory(conceptId: number, url: string | null, style: string | null): Promise<void> {
  if (!url) return;
  const hist = await getRevisionsByConceptVariation(conceptId, HISTORY_KEY);
  if (hist.some((r) => r.resultImageUrl === url)) return;
  await insertRevision({
    id: nanoid(),
    conceptId,
    variationKey: HISTORY_KEY,
    iterationNumber: await getNextIterationNumber(conceptId, HISTORY_KEY),
    instruction: `Generation — ${style ?? "previous"}`,
    referenceImageUrl: url,
    resultImageUrl: url,
    accepted: false,
  });
}

/** Get a single revision by ID */
export async function getRevisionById(revisionId: string): Promise<DesignRevision | null> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");
  const rows = await db
    .select()
    .from(designRevisions)
    .where(eq(designRevisions.id, revisionId))
    .limit(1);
  return rows[0] ?? null;
}

/** Get the next iteration number for a concept+variation */
export async function getNextIterationNumber(
  conceptId: number,
  variationKey: string
): Promise<number> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");
  const rows = await db
    .select({ maxIter: sql<number>`COALESCE(MAX(${designRevisions.iterationNumber}), 0)` })
    .from(designRevisions)
    .where(
      and(
        eq(designRevisions.conceptId, conceptId),
        eq(designRevisions.variationKey, variationKey)
      )
    );
  return (rows[0]?.maxIter ?? 0) + 1;
}

/** Mark a specific revision as accepted (un-accept all others for that concept+variation first) */
export async function markRevisionAccepted(revisionId: string): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");
  const rev = await getRevisionById(revisionId);
  if (!rev) throw new Error(`Revision ${revisionId} not found`);

  // Un-accept all revisions for this concept+variation
  await db
    .update(designRevisions)
    .set({ accepted: false })
    .where(
      and(
        eq(designRevisions.conceptId, rev.conceptId),
        eq(designRevisions.variationKey, rev.variationKey)
      )
    );

  // Accept the specified one
  await db
    .update(designRevisions)
    .set({ accepted: true })
    .where(eq(designRevisions.id, revisionId));
}

/** Dismiss a specific generation history entry (per-version dismiss) */
export async function dismissGeneration(
  revisionId: string,
  tags: string[]
): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");
  await db
    .update(designRevisions)
    .set({ dismissedAt: new Date(), rejectionTags: tags })
    .where(eq(designRevisions.id, revisionId));
}

/** Undismiss a specific generation history entry */
export async function undismissGeneration(revisionId: string): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");
  await db
    .update(designRevisions)
    .set({ dismissedAt: null, rejectionTags: null })
    .where(eq(designRevisions.id, revisionId));
}

/** Delete all revisions for a concept+variation (revert to original) */
export async function deleteRevisionsByConceptVariation(
  conceptId: number,
  variationKey: string
): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");
  await db
    .delete(designRevisions)
    .where(
      and(
        eq(designRevisions.conceptId, conceptId),
        eq(designRevisions.variationKey, variationKey)
      )
    );
}
