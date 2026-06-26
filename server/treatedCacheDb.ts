/**
 * Treated-image cache DB helpers (PO 2026-06-25, per-run mockup treatment).
 * Maps a treatment hash → the stored treated PNG url. Plain functions, no abstractions.
 */
import { eq } from "drizzle-orm";
import { getDb } from "./db";
import { treatedCache } from "../drizzle/schema";

/** Look up a previously-treated image by its treatment hash. null = miss (compute it). */
export async function getTreatedUrl(hash: string): Promise<string | null> {
  const db = await getDb();
  if (!db) return null;
  const rows = await db.select().from(treatedCache).where(eq(treatedCache.hash, hash)).limit(1);
  return rows[0]?.url ?? null;
}

/** Record a treated image url under its hash. Idempotent: two identical concurrent runs may both
 *  miss and both insert — the duplicate key is harmless (same content), so we upsert. */
export async function putTreatedUrl(hash: string, url: string): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db.insert(treatedCache).values({ hash, url }).onDuplicateKeyUpdate({ set: { url } });
}
