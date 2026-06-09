/**
 * Product Group DB helpers — Phase C
 * Karpathy: plain functions, no class hierarchy, no abstractions beyond what's needed.
 */
import { eq, asc } from "drizzle-orm";
import { getDb } from "./db";
import { productGroups, mockupTemplates } from "../drizzle/schema";
import type { ProductGroup, InsertProductGroup, MockupTemplate, InsertMockupTemplate } from "../drizzle/schema";
import { nanoid } from "nanoid";

export async function getProductGroupsByWorkspace(workspaceId: string): Promise<ProductGroup[]> {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(productGroups).where(eq(productGroups.workspaceId, workspaceId));
}

export async function getProductGroupById(id: string): Promise<ProductGroup | null> {
  const db = await getDb();
  if (!db) return null;
  const rows = await db.select().from(productGroups).where(eq(productGroups.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function createProductGroup(
  data: Omit<InsertProductGroup, "id" | "createdAt" | "updatedAt">
): Promise<ProductGroup> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");
  const id = nanoid();
  await db.insert(productGroups).values({ ...data, id });
  const created = await getProductGroupById(id);
  if (!created) throw new Error("Failed to fetch created product group");
  return created;
}

export async function updateProductGroup(
  id: string,
  data: Partial<Pick<InsertProductGroup, "name" | "description" | "compareAtPrice" | "pricingTiers" | "printZone">>
): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");
  await db.update(productGroups).set(data).where(eq(productGroups.id, id));
}

export async function getMockupsByGroup(groupId: string): Promise<MockupTemplate[]> {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(mockupTemplates)
    .where(eq(mockupTemplates.groupId, groupId))
    .orderBy(asc(mockupTemplates.sortOrder));
}

export async function createMockupTemplate(
  data: Omit<InsertMockupTemplate, "id" | "createdAt">
): Promise<MockupTemplate> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");
  const id = nanoid();
  await db.insert(mockupTemplates).values({ ...data, id });
  const rows = await db.select().from(mockupTemplates).where(eq(mockupTemplates.id, id)).limit(1);
  if (!rows[0]) throw new Error("Failed to fetch created mockup template");
  return rows[0];
}

export async function updateMockupTemplate(
  id: string,
  data: Partial<Pick<InsertMockupTemplate, "colorName" | "colorHex" | "availableSizes" | "sortOrder" | "garmentBbox">>
): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");
  await db.update(mockupTemplates).set(data).where(eq(mockupTemplates.id, id));
}

export async function deleteMockupTemplate(id: string): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");
  await db.delete(mockupTemplates).where(eq(mockupTemplates.id, id));
}
