/**
 * Listing DB helpers — Phase I
 * CRUD for shopify_listings table.
 */
import { eq, and, desc } from "drizzle-orm";
import { shopifyListings, type InsertShopifyListing, type ShopifyListing } from "../drizzle/schema";
import { getDb } from "./db";

export async function createListing(data: InsertShopifyListing): Promise<string> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.insert(shopifyListings).values(data);
  return data.id;
}

export async function getListingsByWorkspace(
  workspaceId: string,
  status?: "draft" | "ready" | "exported"
): Promise<ShopifyListing[]> {
  const db = await getDb();
  if (!db) return [];
  const conditions = [eq(shopifyListings.workspaceId, workspaceId)];
  if (status) conditions.push(eq(shopifyListings.status, status));
  return db
    .select()
    .from(shopifyListings)
    .where(and(...conditions))
    .orderBy(desc(shopifyListings.createdAt));
}

export async function getListingById(id: string): Promise<ShopifyListing | undefined> {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(shopifyListings).where(eq(shopifyListings.id, id)).limit(1);
  return result[0];
}

export async function updateListing(
  id: string,
  data: Partial<Pick<ShopifyListing, "title" | "description" | "tags" | "price" | "compareAtPrice" | "status" | "mockupRenderIds" | "shopifyProductId">>
): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db.update(shopifyListings).set(data).where(eq(shopifyListings.id, id));
}

export async function deleteListing(id: string): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db.delete(shopifyListings).where(eq(shopifyListings.id, id));
}
