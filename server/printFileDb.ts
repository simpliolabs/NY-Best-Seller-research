/**
 * Print-files DB helpers (PO 2026-06-17, print-files library).
 * Plain functions, no abstractions beyond what's needed.
 */
import { eq, and, desc } from "drizzle-orm";
import { getDb } from "./db";
import { printFiles } from "../drizzle/schema";
import type { PrintFile } from "../drizzle/schema";
import { nanoid } from "nanoid";

export async function createPrintFile(data: {
  conceptId: number;
  variationKey: string;
  sourceRevisionId?: string | null;
  kind: "fulltone" | "halftone" | "knockout";
  inkColor?: string | null;
  url: string;
  filename: string;
  widthPx: number;
  heightPx: number;
  dpi?: number;
  contentHash?: string | null;
}): Promise<PrintFile> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");
  const id = nanoid();
  await db.insert(printFiles).values({
    id,
    conceptId: data.conceptId,
    variationKey: data.variationKey,
    sourceRevisionId: data.sourceRevisionId ?? null,
    kind: data.kind,
    inkColor: data.inkColor ?? null,
    url: data.url,
    filename: data.filename,
    widthPx: data.widthPx,
    heightPx: data.heightPx,
    dpi: data.dpi ?? 300,
    contentHash: data.contentHash ?? null,
  });
  const rows = await db.select().from(printFiles).where(eq(printFiles.id, id)).limit(1);
  return rows[0]!;
}

/** Find an existing export with the same content hash for this concept — the dedupe lookup, so an
 *  identical re-export reuses the stored file instead of piling up duplicate 69MB PNGs. */
export async function findPrintFileByHash(conceptId: number, contentHash: string): Promise<PrintFile | null> {
  const db = await getDb();
  if (!db) return null;
  const rows = await db
    .select()
    .from(printFiles)
    .where(and(eq(printFiles.conceptId, conceptId), eq(printFiles.contentHash, contentHash)))
    .limit(1);
  return rows[0] ?? null;
}

/** Every print file for a concept, newest first — the library list. */
export async function getPrintFilesByConcept(conceptId: number): Promise<PrintFile[]> {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(printFiles)
    .where(eq(printFiles.conceptId, conceptId))
    .orderBy(desc(printFiles.createdAt));
}
