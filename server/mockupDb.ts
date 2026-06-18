/**
 * Mockup DB helpers — Phase H
 * CRUD for mockup_renders table.
 * Karpathy: plain functions, no class, no speculative abstractions.
 */
import { eq, and } from "drizzle-orm";
import { getDb } from "./db";
import { mockupRenders } from "../drizzle/schema";
import type { MockupRender } from "../drizzle/schema";
import { nanoid } from "nanoid";

export async function createMockupRender(data: {
  conceptId: number;
  variationKey: string;
  templateId: string;
  compositeUrl: string;
  /** PO 2026-06-17, per-design identity: tie this render to a specific design version so
   *  multiple versions' mockups coexist. NULL = legacy live-slot semantics. */
  sourceRevisionId?: string | null;
}): Promise<MockupRender> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");
  const id = nanoid();
  await db.insert(mockupRenders).values({
    id,
    conceptId: data.conceptId,
    variationKey: data.variationKey,
    templateId: data.templateId,
    compositeUrl: data.compositeUrl,
    sourceRevisionId: data.sourceRevisionId ?? null,
  });
  const rows = await db
    .select()
    .from(mockupRenders)
    .where(eq(mockupRenders.id, id))
    .limit(1);
  return rows[0]!;
}

export async function getMockupsByConceptVariation(
  conceptId: number,
  variationKey: string
): Promise<MockupRender[]> {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(mockupRenders)
    .where(
      and(
        eq(mockupRenders.conceptId, conceptId),
        eq(mockupRenders.variationKey, variationKey)
      )
    );
}

/** Renders for a specific design VERSION — used when the Mockups page is viewing a particular
 *  revision's tile, not the live-slot view. (PO 2026-06-17, per-design identity.) */
export async function getMockupsByConceptVariationAndRevision(
  conceptId: number,
  variationKey: string,
  sourceRevisionId: string
): Promise<MockupRender[]> {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(mockupRenders)
    .where(
      and(
        eq(mockupRenders.conceptId, conceptId),
        eq(mockupRenders.variationKey, variationKey),
        eq(mockupRenders.sourceRevisionId, sourceRevisionId)
      )
    );
}

export async function getMockupsByConcept(conceptId: number): Promise<MockupRender[]> {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(mockupRenders)
    .where(eq(mockupRenders.conceptId, conceptId));
}

export async function deleteMockupRender(id: string): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db.delete(mockupRenders).where(eq(mockupRenders.id, id));
}
