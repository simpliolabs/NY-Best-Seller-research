import { eq, desc, asc, and, sql, inArray, isNotNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import {
  InsertUser,
  users,
  botRuns,
  books,
  designConcepts,
  nicheResearch,
  marketValidation,
  type InsertBotRun,
  type InsertBook,
  type InsertDesignConcept,
  type InsertNicheResearch,
  type InsertMarketValidation,
  type BotRun,
  type Book,
  type DesignConcept,
  type NicheResearch,
  type MarketValidation,
  type TrendPattern,
} from "../drizzle/schema";
import { ENV } from "./_core/env";

let _db: ReturnType<typeof drizzle> | null = null;
let _dbLastVerified = 0;
const DB_VERIFY_INTERVAL_MS = 60_000; // re-verify connection every 60s

export async function getDb() {
  const now = Date.now();
  // Create connection if none exists
  if (!_db && process.env.DATABASE_URL) {
    try {
      _db = drizzle(process.env.DATABASE_URL);
      _dbLastVerified = now;
    } catch (error) {
      console.warn("[Database] Failed to connect:", error);
      _db = null;
    }
  }
  // Periodically verify the connection is still alive
  if (_db && now - _dbLastVerified > DB_VERIFY_INTERVAL_MS) {
    try {
      await _db.execute("SELECT 1");
      _dbLastVerified = now;
    } catch (error) {
      console.warn("[Database] Stale connection detected, reconnecting...", error);
      _db = null;
      if (process.env.DATABASE_URL) {
        try {
          _db = drizzle(process.env.DATABASE_URL);
          _dbLastVerified = Date.now();
          console.log("[Database] Reconnected successfully");
        } catch (reconnectError) {
          console.error("[Database] Reconnect failed:", reconnectError);
          _db = null;
        }
      }
    }
  }
  return _db;
}

// ─── User helpers (from scaffold) ──────────────────────────────────────────

export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) {
    throw new Error("User openId is required for upsert");
  }
  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot upsert user: database not available");
    return;
  }
  try {
    const values: InsertUser = { openId: user.openId };
    const updateSet: Record<string, unknown> = {};
    const textFields = ["name", "email", "loginMethod"] as const;
    type TextField = (typeof textFields)[number];
    const assignNullable = (field: TextField) => {
      const value = user[field];
      if (value === undefined) return;
      const normalized = value ?? null;
      values[field] = normalized;
      updateSet[field] = normalized;
    };
    textFields.forEach(assignNullable);
    if (user.lastSignedIn !== undefined) {
      values.lastSignedIn = user.lastSignedIn;
      updateSet.lastSignedIn = user.lastSignedIn;
    }
    if (user.role !== undefined) {
      values.role = user.role;
      updateSet.role = user.role;
    } else if (user.openId === ENV.ownerOpenId) {
      values.role = "admin";
      updateSet.role = "admin";
    }
    if (!values.lastSignedIn) {
      values.lastSignedIn = new Date();
    }
    if (Object.keys(updateSet).length === 0) {
      updateSet.lastSignedIn = new Date();
    }
    await db.insert(users).values(values).onDuplicateKeyUpdate({ set: updateSet });
  } catch (error) {
    console.error("[Database] Failed to upsert user:", error);
    throw error;
  }
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);
  return result.length > 0 ? result[0] : undefined;
}

// ─── Bot Runs helpers ──────────────────────────────────────────────────────

export async function createRun(workspaceId?: string): Promise<number> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const result = await db.insert(botRuns).values({ totalStages: 7, workspaceId: workspaceId ?? null });
  return result[0].insertId;
}

export async function listRunsByWorkspace(workspaceId: string, limit = 50): Promise<BotRun[]> {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(botRuns).where(eq(botRuns.workspaceId, workspaceId)).orderBy(desc(botRuns.createdAt)).limit(limit);
}

export async function getLatestRunByWorkspace(workspaceId: string): Promise<BotRun | undefined> {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(botRuns).where(eq(botRuns.workspaceId, workspaceId)).orderBy(desc(botRuns.createdAt)).limit(1);
  return result[0];
}

export async function getLatestCompletedRunByWorkspace(workspaceId: string): Promise<BotRun | undefined> {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(botRuns).where(and(eq(botRuns.workspaceId, workspaceId), eq(botRuns.status, "completed"))).orderBy(desc(botRuns.createdAt)).limit(1);
  return result[0];
}

export async function updateRunStage(
  runId: number,
  stage: number,
  label: string
): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db
    .update(botRuns)
    .set({ currentStage: stage, stageLabel: label })
    .where(eq(botRuns.id, runId));
}

export async function completeRun(
  runId: number,
  booksProcessed: number,
  imagesGenerated: number,
  topPickTitle?: string,
  topPickIsbn?: string
): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db
    .update(botRuns)
    .set({
      status: "completed",
      currentStage: 7,
      stageLabel: "Complete",
      booksProcessed,
      imagesGenerated,
      topPickTitle: topPickTitle ?? null,
      topPickIsbn: topPickIsbn ?? null,
      completedAt: new Date(),
    })
    .where(eq(botRuns.id, runId));
}

export async function failRun(runId: number, errorLog: string): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db
    .update(botRuns)
    .set({
      status: "failed",
      errorLog,
      completedAt: new Date(),
    })
    .where(eq(botRuns.id, runId));
}

export async function getRunById(runId: number): Promise<BotRun | undefined> {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(botRuns).where(eq(botRuns.id, runId)).limit(1);
  return result[0];
}

export async function getLatestRun(): Promise<BotRun | undefined> {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db
    .select()
    .from(botRuns)
    .orderBy(desc(botRuns.createdAt))
    .limit(1);
  return result[0];
}

export async function getLatestCompletedRun(): Promise<BotRun | undefined> {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db
    .select()
    .from(botRuns)
    .where(eq(botRuns.status, "completed"))
    .orderBy(desc(botRuns.createdAt))
    .limit(1);
  return result[0];
}

export async function listRuns(limit = 50): Promise<BotRun[]> {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(botRuns).orderBy(desc(botRuns.createdAt)).limit(limit);
}

export async function updateRunImagesGenerated(
  runId: number,
  count: number
): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db
    .update(botRuns)
    .set({ imagesGenerated: count })
    .where(eq(botRuns.id, runId));
}

export async function updateRunBooksProcessed(
  runId: number,
  count: number
): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db
    .update(botRuns)
    .set({ booksProcessed: count })
    .where(eq(botRuns.id, runId));
}

// ─── Books helpers ─────────────────────────────────────────────────────────

export async function insertBook(book: InsertBook): Promise<number> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const result = await db.insert(books).values(book);
  return result[0].insertId;
}

/** Title of the per-workspace "Manual Uploads" sentinel book that holds manually-uploaded
 *  designs (a concept requires bookId+runId; this gives manual uploads one to attach to and a
 *  Library group to appear under). */
export const MANUAL_UPLOAD_BOOK_TITLE = "Manual Uploads";

/** Find (or create once) the workspace's "Manual Uploads" book + run. All manual design uploads
 *  for a workspace share this one book/run, so they appear together in the Library (which filters
 *  by run.workspaceId) and flow through Design Studio + Mockups like any concept. */
export async function getOrCreateManualUploadBook(
  workspaceId: string
): Promise<{ bookId: number; runId: number }> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const existing = await db
    .select({ bookId: books.id, runId: books.runId })
    .from(books)
    .innerJoin(botRuns, eq(books.runId, botRuns.id))
    .where(and(eq(botRuns.workspaceId, workspaceId), eq(books.title, MANUAL_UPLOAD_BOOK_TITLE)))
    .limit(1);
  if (existing[0]) return { bookId: existing[0].bookId, runId: existing[0].runId };
  const runId = await createRun(workspaceId);
  const bookId = await insertBook({ runId, title: MANUAL_UPLOAD_BOOK_TITLE, author: "Manual Upload" });
  return { bookId, runId };
}

export async function insertBooks(bookList: InsertBook[]): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  if (bookList.length === 0) return;
  await db.insert(books).values(bookList);
}

/**
 * FOREVER-ID: Upsert books by ISBN.
 * - If a book with this ISBN already exists, UPDATE its metadata (rank, weeksOnList, coverUrl, synopsis, runId)
 * - If not, INSERT a new row
 * - NEVER creates duplicate rows for the same ISBN
 * - Returns the book IDs (canonical forever IDs) for all processed books
 */
export async function upsertBooksByIsbn(
  bookList: InsertBook[]
): Promise<number[]> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  if (bookList.length === 0) return [];

  const resultIds: number[] = [];

  for (const book of bookList) {
    if (!book.isbn) {
      // No ISBN — just insert (rare edge case)
      const result = await db.insert(books).values(book);
      resultIds.push(result[0].insertId);
      continue;
    }

    // Check if book already exists by ISBN
    const existing = await db
      .select({ id: books.id })
      .from(books)
      .where(eq(books.isbn, book.isbn))
      .limit(1);

    if (existing.length > 0) {
      // UPDATE metadata on existing canonical row — NEVER delete, only add/update
      const canonicalId = existing[0].id;
      await db
        .update(books)
        .set({
          runId: book.runId,
          rank: book.rank,
          weeksOnList: book.weeksOnList,
          coverUrl: book.coverUrl,
          synopsis: book.synopsis,
          title: book.title,
          author: book.author,
        })
        .where(eq(books.id, canonicalId));
      resultIds.push(canonicalId);
    } else {
      // INSERT new book — first time we've seen this ISBN
      const result = await db.insert(books).values(book);
      resultIds.push(result[0].insertId);
    }
  }

  return resultIds;
}

/**
 * Fetch books by their canonical IDs (returned from upsertBooksByIsbn).
 */
export async function getBooksByIds(ids: number[]): Promise<Book[]> {
  const db = await getDb();
  if (!db) return [];
  if (ids.length === 0) return [];
  return db.select().from(books).where(inArray(books.id, ids)).orderBy(desc(books.trendScoreTotal));
}

export async function getBooksByRunId(runId: number): Promise<Book[]> {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(books)
    .where(eq(books.runId, runId))
    .orderBy(desc(books.trendScoreTotal));
}

export async function getBookById(bookId: number): Promise<Book | undefined> {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(books).where(eq(books.id, bookId)).limit(1);
  return result[0];
}

export async function updateBookExtraction(
  bookId: number,
  data: Partial<InsertBook>
): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db.update(books).set(data).where(eq(books.id, bookId));
}

export async function updateBookScores(
  bookId: number,
  data: {
    trendScoreTotal: number;
    socialMomentum: number;
    socialRationale: string;
    designNovelty: number;
    designRationale: string;
    audienceSize: number;
    audienceRationale: string;
  }
): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db.update(books).set(data).where(eq(books.id, bookId));
}

export async function updateBookForumSignals(
  bookId: number,
  forumSignals: any
): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db.update(books).set({ forumSignals }).where(eq(books.id, bookId));
}

// ─── Design Concepts helpers ───────────────────────────────────────────────

/** Cap a GENERATED display name at `max` chars (PO 2026-06-12: raw Etsy-title names are
 *  unsustainable) — cuts at a word boundary and strips trailing punctuation. Generation-time only;
 *  manual renames are not capped. */
export function capName(name: string, max = 50): string {
  const clean = (name ?? "")
    .replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&") // scraped-title HTML entities
    .replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  let cut = clean.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  if (lastSpace > 25) cut = cut.slice(0, lastSpace);
  return cut.replace(/[\s,;:\-\/|]+$/g, "");
}

/** Rename a concept (PO 2026-06-12) — the human's chosen name, stored as-is. */
export async function updateConceptName(conceptId: number, name: string): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.update(designConcepts).set({ conceptName: name }).where(eq(designConcepts.id, conceptId));
}

export async function insertConcept(concept: InsertDesignConcept): Promise<number> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const result = await db.insert(designConcepts).values(concept);
  return result[0].insertId;
}

export async function insertConcepts(concepts: InsertDesignConcept[]): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  if (concepts.length === 0) return;
  await db.insert(designConcepts).values(concepts);
}

export async function getConceptsByBookId(bookId: number): Promise<DesignConcept[]> {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(designConcepts).where(eq(designConcepts.bookId, bookId));
}

/**
 * Get ALL concepts across ALL book instances with the same ISBN.
 * This ensures BookDetail shows the full history of concepts for a book
 * across all pipeline runs, not just the latest run's book ID.
 */
export async function getAllConceptsByIsbn(isbn: string): Promise<DesignConcept[]> {
  const db = await getDb();
  if (!db) return [];
  // Find all book IDs with this ISBN
  const bookRows = await db.select({ id: books.id }).from(books).where(eq(books.isbn, isbn));
  if (bookRows.length === 0) return [];
  const bookIds = bookRows.map((b) => b.id);
  // Fetch all concepts for all those book IDs
  return db.select().from(designConcepts).where(inArray(designConcepts.bookId, bookIds));
}

export async function getConceptsByRunId(runId: number): Promise<DesignConcept[]> {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(designConcepts).where(eq(designConcepts.runId, runId));
}

/** Update a concept's free-text style label (used when re-rolling a concept's image in a chosen
 *  style, so the Library filter + future prompts reflect the new style). */
export async function updateConceptStyle(conceptId: number, style: string): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db.update(designConcepts).set({ style }).where(eq(designConcepts.id, conceptId));
}

export async function updateConceptImages(
  conceptId: number,
  data: {
    imageUrlA?: string | null;
    imageUrlB?: string | null;
    imageUrlC?: string | null;
    imagePromptA?: string | null;
    imagePromptB?: string | null;
    imagePromptC?: string | null;
    isWinner?: boolean;
    globalRank?: number;
  }
): Promise<void> {
  const db = await getDb();
  if (!db) return;

  // IMMUTABILITY GUARD: Never overwrite existing non-null image URLs with null.
  // Concepts are permanent records — once an image is generated it must never be erased.
  if (data.imageUrlA === null || data.imageUrlB === null || data.imageUrlC === null) {
    const existing = await db
      .select({ imageUrlA: designConcepts.imageUrlA, imageUrlB: designConcepts.imageUrlB, imageUrlC: designConcepts.imageUrlC })
      .from(designConcepts)
      .where(eq(designConcepts.id, conceptId))
      .limit(1);
    const row = existing[0];
    if (row) {
      if (data.imageUrlA === null && row.imageUrlA) {
        delete data.imageUrlA; // preserve existing
      }
      if (data.imageUrlB === null && row.imageUrlB) {
        delete data.imageUrlB; // preserve existing
      }
      if (data.imageUrlC === null && row.imageUrlC) {
        delete data.imageUrlC; // preserve existing
      }
    }
  }

  await db.update(designConcepts).set(data).where(eq(designConcepts.id, conceptId));
}

/** Dismiss → signal (PO 2026-06-15): mark a scan design as buyer-rejected. Its rejectionTags feed the
 *  NEXT scan's council avoidDirectives, exactly like a dismissed trend_pattern. Reversible. */
export async function dismissDesignConcept(conceptId: number, rejectionTags: string[]): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db.update(designConcepts).set({ dismissedAt: new Date(), rejectionTags }).where(eq(designConcepts.id, conceptId));
}

/** Undo a dismiss (clear the flag + tags). */
export async function undismissDesignConcept(conceptId: number): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db.update(designConcepts).set({ dismissedAt: null, rejectionTags: null }).where(eq(designConcepts.id, conceptId));
}

/** All rejectionTags from this workspace's dismissed scan designs (across runs) — feeds the council's
 *  avoidDirectives so the scan learns from buyer dismissals, NH-style (PO 2026-06-15). */
export async function getDismissedConceptTagsByWorkspace(workspaceId: string): Promise<string[]> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db
    .select({ tags: designConcepts.rejectionTags })
    .from(designConcepts)
    .innerJoin(botRuns, eq(designConcepts.runId, botRuns.id))
    .where(and(eq(botRuns.workspaceId, workspaceId), isNotNull(designConcepts.dismissedAt)));
  return rows.flatMap((r) => (r.tags as string[] | null) ?? []);
}

export async function updateConceptScore(
  conceptId: number,
  trendScore: number
): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db
    .update(designConcepts)
    .set({ trendScore })
    .where(eq(designConcepts.id, conceptId));
}

export async function toggleFavorite(conceptId: number): Promise<boolean> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const existing = await db
    .select()
    .from(designConcepts)
    .where(eq(designConcepts.id, conceptId))
    .limit(1);
  if (!existing[0]) throw new Error("Concept not found");
  const newValue = !existing[0].isFavorite;
  await db
    .update(designConcepts)
    .set({ isFavorite: newValue })
    .where(eq(designConcepts.id, conceptId));
  return newValue;
}

export async function getFavorites(filters?: {
  format?: string;
  style?: string;
  subgenre?: string;
  humorFramework?: string;
}): Promise<(DesignConcept & { bookTitle: string | null; bookAuthor: string | null; bookSubgenre: string | null })[]> {
  const db = await getDb();
  if (!db) return [];

  const conditions = [eq(designConcepts.isFavorite, true)];
  if (filters?.format) {
    conditions.push(eq(designConcepts.format, filters.format));
  }
  if (filters?.style) {
    conditions.push(eq(designConcepts.style, filters.style));
  }
  if (filters?.humorFramework) {
    conditions.push(eq(designConcepts.humorFramework, filters.humorFramework));
  }

  const results = await db
    .select({
      id: designConcepts.id,
      bookId: designConcepts.bookId,
      runId: designConcepts.runId,
      conceptName: designConcepts.conceptName,
      format: designConcepts.format,
      style: designConcepts.style,
      headline: designConcepts.headline,
      subtext: designConcepts.subtext,
      colorPalette: designConcepts.colorPalette,
      layoutDescription: designConcepts.layoutDescription,
      fontSuggestion: designConcepts.fontSuggestion,
      copyrightSafe: designConcepts.copyrightSafe,
      isFavorite: designConcepts.isFavorite,
      humorFramework: designConcepts.humorFramework,
      imageUrlA: designConcepts.imageUrlA,
      imageUrlB: designConcepts.imageUrlB,
      imageUrlC: designConcepts.imageUrlC,
      imagePromptA: designConcepts.imagePromptA,
      imagePromptB: designConcepts.imagePromptB,
      imagePromptC: designConcepts.imagePromptC,
      isWinner: designConcepts.isWinner,
      globalRank: designConcepts.globalRank,
      trendScore: designConcepts.trendScore,
      nicheResearchId: designConcepts.nicheResearchId,
      refreshSource: designConcepts.refreshSource,
      signalTags: designConcepts.signalTags,
      sourcePhrase: designConcepts.sourcePhrase,
      nichePatternId: designConcepts.nichePatternId,
      productionUrlA: designConcepts.productionUrlA,
      productionUrlB: designConcepts.productionUrlB,
      productionUrlC: designConcepts.productionUrlC,
      printPlacements: designConcepts.printPlacements,
      dismissedAt: designConcepts.dismissedAt,
      rejectionTags: designConcepts.rejectionTags,
      createdAt: designConcepts.createdAt,
      bookTitle: books.title,
      bookAuthor: books.author,
      bookSubgenre: books.subgenre,
    })
    .from(designConcepts)
    .leftJoin(books, eq(designConcepts.bookId, books.id))
    .where(and(...conditions))
    .orderBy(desc(designConcepts.createdAt));

  if (filters?.subgenre) {
    return results.filter((r) => r.bookSubgenre === filters.subgenre);
  }

  return results;
}

export async function getDistinctFormats(): Promise<string[]> {
  const db = await getDb();
  if (!db) return [];
  const result = await db
    .selectDistinct({ format: designConcepts.format })
    .from(designConcepts);
  return result.map((r) => r.format);
}

export async function getDistinctStyles(): Promise<string[]> {
  const db = await getDb();
  if (!db) return [];
  const result = await db
    .selectDistinct({ style: designConcepts.style })
    .from(designConcepts);
  return result.map((r) => r.style);
}

export async function getDistinctSubgenres(): Promise<string[]> {
  const db = await getDb();
  if (!db) return [];
  const result = await db
    .selectDistinct({ subgenre: books.subgenre })
    .from(books)
    .where(sql`${books.subgenre} IS NOT NULL`);
  return result.map((r) => r.subgenre!).filter(Boolean);
}

export async function getDistinctHumorFrameworks(): Promise<string[]> {
  const db = await getDb();
  if (!db) return [];
  const result = await db
    .selectDistinct({ humorFramework: designConcepts.humorFramework })
    .from(designConcepts)
    .where(sql`${designConcepts.humorFramework} IS NOT NULL`);
  return result.map((r) => r.humorFramework!).filter(Boolean);
}

// ─── Niche Research helpers ───────────────────────────────────────────────

export async function insertNicheResearch(data: InsertNicheResearch): Promise<number> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const result = await db.insert(nicheResearch).values(data);
  return result[0].insertId;
}

export async function getNicheResearchByBookId(bookId: number): Promise<NicheResearch | undefined> {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db
    .select()
    .from(nicheResearch)
    .where(eq(nicheResearch.bookId, bookId))
    .orderBy(desc(nicheResearch.createdAt))
    .limit(1);
  return result[0];
}

export async function getNicheResearchByRunId(runId: number): Promise<NicheResearch[]> {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(nicheResearch).where(eq(nicheResearch.runId, runId));
}

// ─── Market Validation helpers ────────────────────────────────────────────

export async function insertMarketValidation(data: InsertMarketValidation): Promise<number> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const result = await db.insert(marketValidation).values(data);
  return result[0].insertId;
}

export async function getMarketValidationByConceptId(conceptId: number): Promise<MarketValidation | undefined> {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db
    .select()
    .from(marketValidation)
    .where(eq(marketValidation.conceptId, conceptId))
    .orderBy(desc(marketValidation.validatedAt))
    .limit(1);
  return result[0];
}

export async function getMarketValidationsByConceptIds(conceptIds: number[]): Promise<MarketValidation[]> {
  const db = await getDb();
  if (!db) return [];
  if (conceptIds.length === 0) return [];
  return db
    .select()
    .from(marketValidation)
    .where(sql`${marketValidation.conceptId} IN (${sql.join(conceptIds.map(id => sql`${id}`), sql`, `)})`);
}

/** Get high-scoring concepts (above threshold) for a given run */
export async function getHighScoringConcepts(
  runId: number,
  threshold: number
): Promise<DesignConcept[]> {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(designConcepts)
    .where(
      and(
        eq(designConcepts.runId, runId),
        sql`${designConcepts.trendScore} >= ${threshold}`
      )
    )
    .orderBy(desc(designConcepts.trendScore));
}

// ─── Cross-Run Trend Comparison helpers ──────────────────────────────────

/**
 * Get the most recent completed run ID before the given run.
 */
export async function getPreviousCompletedRunId(currentRunId: number): Promise<number | null> {
  const db = await getDb();
  if (!db) return null;
  const result = await db
    .select({ id: botRuns.id })
    .from(botRuns)
    .where(and(eq(botRuns.status, "completed"), sql`${botRuns.id} < ${currentRunId}`))
    .orderBy(desc(botRuns.id))
    .limit(1);
  return result[0]?.id ?? null;
}

/**
 * Get books from a specific run indexed by ISBN for quick lookup.
 */
export async function getBooksByRunIdIndexedByIsbn(
  runId: number
): Promise<Map<string, Book>> {
  const db = await getDb();
  if (!db) return new Map();
  const bookList = await db.select().from(books).where(eq(books.runId, runId));
  const map = new Map<string, Book>();
  for (const b of bookList) {
    if (b.isbn) map.set(b.isbn, b);
  }
  return map;
}

/**
 * Update a book's trend tracking fields (direction, delta, streak, previous scores).
 */
export async function updateBookTrend(
  bookId: number,
  data: {
    trendDirection: "up" | "down" | "stable" | "new";
    previousTrendScore: number | null;
    scoreDelta: number | null;
    previousRank: number | null;
    streakCount: number;
  }
): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db.update(books).set(data).where(eq(books.id, bookId));
}

// ─── V4: Concept Library helpers ─────────────────────────────────────────

/**
 * Get ALL concepts across ALL runs with optional filtering, pagination, and sorting.
 * Used by the Concept Library page (KaloData-style product discovery).
 */
export async function getAllConcepts(opts: {
  limit: number;
  offset: number;
  bookTitle?: string;
  winnersOnly?: boolean;
  minScore?: number;
  maxScore?: number;
  format?: string;
  style?: string;
  humorFramework?: string;
  sortBy?: "score" | "date" | "rank" | "hasImages";
  sortDir?: "asc" | "desc";
  workspaceId?: string;
}): Promise<{ concepts: (DesignConcept & { bookTitle: string; bookAuthor: string; bookIsbn: string | null; runDate: Date })[]; total: number }> {
  const db = await getDb();
  if (!db) return { concepts: [], total: 0 };

  const conditions: any[] = [];
  if (opts.winnersOnly) {
    conditions.push(eq(designConcepts.isWinner, true));
  }
  if (opts.minScore !== undefined) {
    conditions.push(sql`${designConcepts.trendScore} >= ${opts.minScore}`);
  }
  if (opts.maxScore !== undefined) {
    conditions.push(sql`${designConcepts.trendScore} <= ${opts.maxScore}`);
  }
  if (opts.format) {
    conditions.push(eq(designConcepts.format, opts.format));
  }
  if (opts.style) {
    conditions.push(eq(designConcepts.style, opts.style));
  }
  if (opts.humorFramework) {
    conditions.push(eq(designConcepts.humorFramework, opts.humorFramework));
  }
  if (opts.bookTitle) {
    conditions.push(sql`${books.title} LIKE ${`%${opts.bookTitle}%`}`);
  }
  if (opts.workspaceId) {
    conditions.push(eq(botRuns.workspaceId, opts.workspaceId));
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  // Determine sort
  let orderClause;
  const direction = opts.sortDir === "asc" ? asc : desc;
  switch (opts.sortBy) {
    case "score":
      orderClause = direction(designConcepts.trendScore);
      break;
    case "rank":
      orderClause = direction(designConcepts.globalRank);
      break;
    case "hasImages":
      // Images first, then by score descending as tiebreaker
      orderClause = sql`CASE WHEN ${designConcepts.imageUrlA} IS NOT NULL THEN 0 ELSE 1 END ASC, ${designConcepts.trendScore} DESC`;
      break;
    case "date":
    default:
      orderClause = direction(designConcepts.createdAt);
      break;
  }

  const results = await db
    .select({
      id: designConcepts.id,
      bookId: designConcepts.bookId,
      runId: designConcepts.runId,
      conceptName: designConcepts.conceptName,
      format: designConcepts.format,
      style: designConcepts.style,
      headline: designConcepts.headline,
      subtext: designConcepts.subtext,
      colorPalette: designConcepts.colorPalette,
      layoutDescription: designConcepts.layoutDescription,
      fontSuggestion: designConcepts.fontSuggestion,
      copyrightSafe: designConcepts.copyrightSafe,
      isFavorite: designConcepts.isFavorite,
      humorFramework: designConcepts.humorFramework,
      isWinner: designConcepts.isWinner,
      globalRank: designConcepts.globalRank,
      imageUrlA: designConcepts.imageUrlA,
      imageUrlB: designConcepts.imageUrlB,
      imageUrlC: designConcepts.imageUrlC,
      imagePromptA: designConcepts.imagePromptA,
      imagePromptB: designConcepts.imagePromptB,
      imagePromptC: designConcepts.imagePromptC,
      trendScore: designConcepts.trendScore,
      nicheResearchId: designConcepts.nicheResearchId,
      refreshSource: designConcepts.refreshSource,
      signalTags: designConcepts.signalTags,
      sourcePhrase: designConcepts.sourcePhrase,
      nichePatternId: designConcepts.nichePatternId,
      productionUrlA: designConcepts.productionUrlA,
      productionUrlB: designConcepts.productionUrlB,
      productionUrlC: designConcepts.productionUrlC,
      createdAt: designConcepts.createdAt,
      bookTitle: books.title,
      bookAuthor: books.author,
      bookIsbn: books.isbn,
      runDate: botRuns.createdAt,
      // Book-level scoring breakdown for lightbox "Why This Won"
      bookSocialMomentum: books.socialMomentum,
      bookSocialRationale: books.socialRationale,
      bookDesignNovelty: books.designNovelty,
      bookDesignRationale: books.designRationale,
      bookAudienceSize: books.audienceSize,
      bookAudienceRationale: books.audienceRationale,
    })
    .from(designConcepts)
    .leftJoin(books, eq(designConcepts.bookId, books.id))
    .leftJoin(botRuns, eq(designConcepts.runId, botRuns.id))
    .where(whereClause)
    .orderBy(orderClause)
    .limit(opts.limit)
    .offset(opts.offset);

  // Count total — must join same tables as main query so workspaceId filter works
  const countResult = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(designConcepts)
    .leftJoin(books, eq(designConcepts.bookId, books.id))
    .leftJoin(botRuns, eq(designConcepts.runId, botRuns.id))
    .where(whereClause);

  const total = Number(countResult[0]?.count ?? 0);

  return { concepts: results as any, total };
}

// ─── V4: Book Registry / Analytics helpers ───────────────────────────────

/**
 * Get all unique books across all runs, grouped by ISBN.
 * Returns the latest version of each book with appearance count and latest scores.
 */
export async function getBookRegistry(workspaceId?: string): Promise<{
  isbn: string;
  title: string;
  author: string;
  coverUrl: string | null;
  latestBookId: number;
  latestRunId: number;
  appearanceCount: number;
  latestScore: number | null;
  latestSocialMomentum: number | null;
  latestDesignNovelty: number | null;
  latestAudienceSize: number | null;
  latestRunDate: Date | null;
  winnerConceptCount: number;
}[]> {
  const db = await getDb();
  if (!db) return [];

  // Get all books with ISBNs, ordered by run date descending
  // Scope to workspace via botRuns join when workspaceId is provided
  let allBooks;
  if (workspaceId) {
    allBooks = await db
      .select({
        id: books.id,
        runId: books.runId,
        title: books.title,
        author: books.author,
        isbn: books.isbn,
        coverUrl: books.coverUrl,
        trendScoreTotal: books.trendScoreTotal,
        socialMomentum: books.socialMomentum,
        designNovelty: books.designNovelty,
        audienceSize: books.audienceSize,
        createdAt: books.createdAt,
      })
      .from(books)
      .innerJoin(botRuns, eq(books.runId, botRuns.id))
      .where(and(
        sql`${books.isbn} IS NOT NULL AND ${books.isbn} != ''`,
        eq(botRuns.workspaceId, workspaceId)
      ))
      .orderBy(desc(books.createdAt));
  } else {
    allBooks = await db
      .select()
      .from(books)
      .where(sql`${books.isbn} IS NOT NULL AND ${books.isbn} != ''`)
      .orderBy(desc(books.createdAt));
  }

  // Group by ISBN, keeping the latest entry as primary
  const isbnMap = new Map<string, {
    isbn: string;
    title: string;
    author: string;
    coverUrl: string | null;
    latestBookId: number;
    latestRunId: number;
    appearanceCount: number;
    latestScore: number | null;
    latestSocialMomentum: number | null;
    latestDesignNovelty: number | null;
    latestAudienceSize: number | null;
    latestRunDate: Date | null;
  }>();

  for (const b of allBooks) {
    if (!b.isbn) continue;
    if (!isbnMap.has(b.isbn)) {
      isbnMap.set(b.isbn, {
        isbn: b.isbn,
        title: b.title,
        author: b.author,
        coverUrl: b.coverUrl,
        latestBookId: b.id,
        latestRunId: b.runId,
        appearanceCount: 1,
        latestScore: b.trendScoreTotal,
        latestSocialMomentum: b.socialMomentum,
        latestDesignNovelty: b.designNovelty,
        latestAudienceSize: b.audienceSize,
        latestRunDate: b.createdAt,
      });
    } else {
      isbnMap.get(b.isbn)!.appearanceCount++;
    }
  }

  // Get winner concept counts per book ISBN
  const registry = Array.from(isbnMap.values());
  const bookIds = registry.map(r => r.latestBookId);

  if (bookIds.length === 0) return [];

  // Count winning concepts for each book's latest run entry
  const winnerCounts = await db
    .select({
      bookId: designConcepts.bookId,
      count: sql<number>`COUNT(*)`,
    })
    .from(designConcepts)
    .where(and(
      eq(designConcepts.isWinner, true),
      sql`${designConcepts.bookId} IN (${sql.join(bookIds.map(id => sql`${id}`), sql`, `)})`
    ))
    .groupBy(designConcepts.bookId);

  const winnerMap = new Map<number, number>();
  for (const wc of winnerCounts) {
    winnerMap.set(wc.bookId, Number(wc.count));
  }

  return registry.map(r => ({
    ...r,
    winnerConceptCount: winnerMap.get(r.latestBookId) ?? 0,
  }));
}

/**
 * Get time-series trend data for a specific book (by ISBN) across all runs.
 * Used for the 3 analytics charts: Score Trajectory, Forum Signal, Concept Signal.
 */
export async function getBookTrendData(isbn: string, days?: number): Promise<{
  dataPoints: {
    runId: number;
    runDate: Date;
    bookId: number;
    trendScoreTotal: number | null;
    socialMomentum: number | null;
    designNovelty: number | null;
    audienceSize: number | null;
    forumSignals: any;
    conceptCount: number;
    avgConceptScore: number | null;
    maxConceptScore: number | null;
    winnerCount: number;
  }[];
}> {
  const db = await getDb();
  if (!db) return { dataPoints: [] };

  let dateFilter = sql`1=1`;
  if (days) {
    dateFilter = sql`${books.createdAt} >= DATE_SUB(NOW(), INTERVAL ${days} DAY)`;
  }

  // Get all book entries for this ISBN across runs
  const bookEntries = await db
    .select()
    .from(books)
    .where(and(eq(books.isbn, isbn), dateFilter))
    .orderBy(asc(books.createdAt));

  if (bookEntries.length === 0) return { dataPoints: [] };

  // Get concept stats for each book entry
  const dataPoints = [];
  for (const b of bookEntries) {
    const concepts = await db
      .select()
      .from(designConcepts)
      .where(eq(designConcepts.bookId, b.id));

    const scores = concepts
      .map(c => c.trendScore)
      .filter((s): s is number => s !== null && s > 0);

    const run = await db
      .select({ createdAt: botRuns.createdAt })
      .from(botRuns)
      .where(eq(botRuns.id, b.runId))
      .limit(1);

    dataPoints.push({
      runId: b.runId,
      runDate: run[0]?.createdAt ?? b.createdAt,
      bookId: b.id,
      trendScoreTotal: b.trendScoreTotal,
      socialMomentum: b.socialMomentum,
      designNovelty: b.designNovelty,
      audienceSize: b.audienceSize,
      forumSignals: b.forumSignals,
      conceptCount: concepts.length,
      avgConceptScore: scores.length > 0 ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null,
      maxConceptScore: scores.length > 0 ? Math.max(...scores) : null,
      winnerCount: concepts.filter(c => c.isWinner).length,
    });
  }

  return { dataPoints };
}

// ─── V4: Production Export helpers ───────────────────────────────────────

/**
 * Get a single concept by ID (for production export).
 */
export async function getConceptById(conceptId: number): Promise<DesignConcept | undefined> {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db
    .select()
    .from(designConcepts)
    .where(eq(designConcepts.id, conceptId))
    .limit(1);
  return result[0];
}

/**
 * Get a single concept by ID with book title/author joined.
 * Used by the lightbox to auto-fetch details when not provided.
 */
export async function getConceptWithBookById(conceptId: number) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db
    .select({
      id: designConcepts.id,
      bookId: designConcepts.bookId,
      runId: designConcepts.runId,
      conceptName: designConcepts.conceptName,
      format: designConcepts.format,
      style: designConcepts.style,
      headline: designConcepts.headline,
      subtext: designConcepts.subtext,
      colorPalette: designConcepts.colorPalette,
      layoutDescription: designConcepts.layoutDescription,
      fontSuggestion: designConcepts.fontSuggestion,
      humorFramework: designConcepts.humorFramework,
      isWinner: designConcepts.isWinner,
      globalRank: designConcepts.globalRank,
      imageUrlA: designConcepts.imageUrlA,
      imageUrlB: designConcepts.imageUrlB,
      imageUrlC: designConcepts.imageUrlC,
      imagePromptA: designConcepts.imagePromptA,
      imagePromptB: designConcepts.imagePromptB,
      imagePromptC: designConcepts.imagePromptC,
      trendScore: designConcepts.trendScore,
      signalTags: designConcepts.signalTags,
      sourcePhrase: designConcepts.sourcePhrase,
      nichePatternId: designConcepts.nichePatternId,
      createdAt: designConcepts.createdAt,
      bookTitle: books.title,
      bookAuthor: books.author,
      // Book-level scoring breakdown for lightbox "Why This Won"
      bookSocialMomentum: books.socialMomentum,
      bookSocialRationale: books.socialRationale,
      bookDesignNovelty: books.designNovelty,
      bookDesignRationale: books.designRationale,
      bookAudienceSize: books.audienceSize,
      bookAudienceRationale: books.audienceRationale,
    })
    .from(designConcepts)
    .leftJoin(books, eq(designConcepts.bookId, books.id))
    .where(eq(designConcepts.id, conceptId))
    .limit(1);
  return result[0];
}

/**
 * Update a concept's production URL for a specific variation.
 */
export async function updateConceptProductionUrl(
  conceptId: number,
  variation: "A" | "B" | "C",
  url: string | null
): Promise<void> {
  const db = await getDb();
  if (!db) return;
  const field = variation === "A" ? { productionUrlA: url }
    : variation === "B" ? { productionUrlB: url }
    : { productionUrlC: url };
  await db.update(designConcepts).set(field).where(eq(designConcepts.id, conceptId));
}

/**
 * Update a book's refreshedAt timestamp.
 */
export async function updateBookRefreshedAt(bookId: number): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db.update(books).set({ refreshedAt: new Date() }).where(eq(books.id, bookId));
}

/**
 * Get distinct book titles across all runs for the library filter dropdown.
 */
export async function getDistinctBookTitles(workspaceId?: string): Promise<string[]> {
  const db = await getDb();
  if (!db) return [];
  if (workspaceId) {
    const result = await db
      .selectDistinct({ title: books.title })
      .from(books)
      .innerJoin(botRuns, eq(books.runId, botRuns.id))
      .where(eq(botRuns.workspaceId, workspaceId));
    return result.map((r) => r.title).sort();
  }
  const result = await db
    .selectDistinct({ title: books.title })
    .from(books);
  return result.map((r) => r.title).sort();
}


// ─── Concept Delete ─────────────────────────────────────────────────────────

export async function deleteConceptById(conceptId: number): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db.delete(designConcepts).where(eq(designConcepts.id, conceptId));
}

// ─── Pipeline Heartbeat ─────────────────────────────────────────────────────

export async function updateRunHeartbeat(runId: number): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db
    .update(botRuns)
    .set({ lastHeartbeat: new Date() })
    .where(eq(botRuns.id, runId));
}

// ─── DB Auto-Reconnect Wrapper ──────────────────────────────────────────────

/**
 * Wraps a DB operation with auto-reconnect on connection failures.
 * If the first attempt fails with a connection error, waits briefly and retries once.
 */
export async function withDbReconnect<T>(
  label: string,
  fn: () => Promise<T>
): Promise<T> {
  try {
    return await fn();
  } catch (err: any) {
    const msg = (err?.message ?? "").toLowerCase();
    const isConnectionError =
      msg.includes("econnrefused") ||
      msg.includes("econnreset") ||
      msg.includes("connection lost") ||
      msg.includes("connection closed") ||
      msg.includes("too many connections") ||
      msg.includes("gone away") ||
      msg.includes("etimedout");

    if (!isConnectionError) throw err;

    console.warn(`[DB] ${label}: Connection error, retrying in 2s...`, err.message);
    await new Promise((r) => setTimeout(r, 2000));

    try {
      return await fn();
    } catch (retryErr) {
      console.error(`[DB] ${label}: Retry also failed`, retryErr);
      throw retryErr;
    }
  }
}

// ─── Query Timeout Wrapper ──────────────────────────────────────────────────

/**
 * Wraps a DB query with a timeout. Rejects if the query takes longer than timeoutMs.
 */
export async function withQueryTimeout<T>(
  label: string,
  timeoutMs: number,
  fn: () => Promise<T>
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`[DB] Query timeout after ${timeoutMs}ms: ${label}`)),
      timeoutMs
    );
    fn()
      .then((val) => { clearTimeout(timer); resolve(val); })
      .catch((err) => { clearTimeout(timer); reject(err); });
  });
}

export async function updateConceptSignalTags(
  conceptId: number,
  signalTags: string[]
): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db
    .update(designConcepts)
    .set({ signalTags })
    .where(eq(designConcepts.id, conceptId));
}

export async function updateBookStyleDirectives(
  bookId: number,
  directives: import("../shared/styleProfile").StyleProfile
): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db.update(books).set({ styleDirectives: directives }).where(eq(books.id, bookId));
}

// ─── Niche Pattern → Concept Library ────────────────────────────────────────

/**
 * Phase 3: Create a design_concept row from an approved Niche Hunter pattern.
 * Uses the existing synthetic-book pattern: upserts a book row with a stable ISBN
 * derived from the pattern name, then inserts a concept linked to that book.
 * Returns the new concept ID.
 */
export async function createConceptFromPattern(
  pattern: TrendPattern,
  workspaceId: string
): Promise<number> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  // Find or create a workspace-scoped run to attach the concept to.
  // Reuse the latest completed run if available; otherwise create a placeholder run.
  let run = await getLatestCompletedRunByWorkspace(workspaceId);
  if (!run) {
    const runId = await createRun(workspaceId);
    await completeRun(runId, 0, 0);
    run = { id: runId } as BotRun;
  }

  // Stable synthetic ISBN from pattern name (same convention as stageNicheIngest)
  const stableIsbn = `niche-pattern-${Buffer.from(pattern.patternName).toString("base64").slice(0, 12)}`;

  // Upsert a synthetic book row so bookId NOT NULL constraint is satisfied
  const [bookId] = await upsertBooksByIsbn([
    {
      runId: run.id,
      title: pattern.patternName,
      author: `Niche Hunter: ${pattern.sourceCategory ?? "Cross-Niche"}`,
      isbn: stableIsbn,
      coverUrl: pattern.previewImageUrl ?? "",
      synopsis: pattern.adaptedConcept ?? "",
      rank: pattern.score ?? 50,
      weeksOnList: 0,
    },
  ]);

  // Insert the concept
  const conceptId = await insertConcept({
    bookId,
    runId: run.id,
    conceptName: capName(pattern.patternName), // 50-char cap on generated names (PO 2026-06-12)
    format: "t-shirt",
    style: pattern.colorStrategy ?? "niche-adapted",
    headline: pattern.adaptedConcept ?? pattern.patternName,
    subtext: pattern.emotionalHook ?? null,
    colorPalette: null,
    layoutDescription: pattern.composition ?? null,
    fontSuggestion: null,
    copyrightSafe: true,
    isFavorite: false,
    humorFramework: (pattern.transferablePattern ?? "").slice(0, 500) || null,
    isWinner: false,
    globalRank: null,
    // The Design Studio REVISES this image, so it must be the canonical CLEAN design
    // (productionDesignUrl), NOT previewImageUrl — which is compositor(design + shirt template),
    // i.e. the on-shirt MOCKUP (PO-flagged 2026-06-10: revisions were landing on the shirt photo).
    // Fall back to the mockup, then null, only if the canonical design isn't produced yet.
    imageUrlA: pattern.productionDesignUrl ?? pattern.previewImageUrl ?? null,
    imageUrlB: null,
    imageUrlC: null,
    imagePromptA: null,
    imagePromptB: null,
    imagePromptC: null,
    trendScore: pattern.score ?? null,
    nicheResearchId: null,
    refreshSource: "full_run",
    signalTags: null,
    sourcePhrase: pattern.whyItWorks ?? null,
    nichePatternId: pattern.id,
    productionUrlA: null,
    productionUrlB: null,
    productionUrlC: null,
  });

  return conceptId;
}
