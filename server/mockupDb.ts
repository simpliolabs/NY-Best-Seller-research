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
}): Promise<MockupRender> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");
  const id = nanoid();
  await db.insert(mockupRenders).values({ id, ...data });
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
