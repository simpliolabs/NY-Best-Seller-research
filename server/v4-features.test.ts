import { describe, expect, it } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

type AuthenticatedUser = NonNullable<TrpcContext["user"]>;

function createAuthContext(): { ctx: TrpcContext } {
  const user: AuthenticatedUser = {
    id: 1,
    openId: "sample-user",
    email: "sample@example.com",
    name: "Sample User",
    loginMethod: "manus",
    role: "user",
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSignedIn: new Date(),
  };

  const ctx: TrpcContext = {
    user,
    req: {
      protocol: "https",
      headers: {},
    } as TrpcContext["req"],
    res: {
      clearCookie: () => {},
    } as TrpcContext["res"],
  };

  return { ctx };
}

function createPublicContext(): { ctx: TrpcContext } {
  const ctx: TrpcContext = {
    user: null,
    req: {
      protocol: "https",
      headers: {},
    } as TrpcContext["req"],
    res: {
      clearCookie: () => {},
    } as TrpcContext["res"],
  };

  return { ctx };
}

describe("library.list", () => {
  it("returns concepts array and total count with default params", async () => {
    const { ctx } = createPublicContext();
    const caller = appRouter.createCaller(ctx);

    const result = await caller.library.list({
      limit: 10,
      offset: 0,
    });

    expect(result).toHaveProperty("concepts");
    expect(result).toHaveProperty("total");
    expect(Array.isArray(result.concepts)).toBe(true);
    expect(typeof result.total).toBe("number");
    expect(result.total).toBeGreaterThanOrEqual(0);
  });

  it("respects pagination limit", async () => {
    const { ctx } = createPublicContext();
    const caller = appRouter.createCaller(ctx);

    const result = await caller.library.list({
      limit: 5,
      offset: 0,
    });

    expect(result.concepts.length).toBeLessThanOrEqual(5);
  });

  it("returns concepts with expected fields", async () => {
    const { ctx } = createPublicContext();
    const caller = appRouter.createCaller(ctx);

    const result = await caller.library.list({
      limit: 1,
      offset: 0,
    });

    if (result.concepts.length > 0) {
      const concept = result.concepts[0];
      expect(concept).toHaveProperty("id");
      expect(concept).toHaveProperty("conceptName");
      expect(concept).toHaveProperty("format");
      expect(concept).toHaveProperty("style");
      expect(concept).toHaveProperty("bookTitle");
      expect(concept).toHaveProperty("trendScore");
    }
  });

  it("filters by winnersOnly", async () => {
    const { ctx } = createPublicContext();
    const caller = appRouter.createCaller(ctx);

    const result = await caller.library.list({
      limit: 100,
      offset: 0,
      winnersOnly: true,
    });

    // All returned concepts should be winners
    for (const concept of result.concepts) {
      expect(concept.isWinner).toBe(true);
    }
  });

  it("sorts by score descending", async () => {
    const { ctx } = createPublicContext();
    const caller = appRouter.createCaller(ctx);

    const result = await caller.library.list({
      limit: 10,
      offset: 0,
      sortBy: "score",
      sortDir: "desc",
    });

    const scores = result.concepts.map(c => c.trendScore ?? 0);
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]).toBeLessThanOrEqual(scores[i - 1]);
    }
  });
});

describe("library.getFilterOptions", () => {
  it("returns filter option arrays", async () => {
    const { ctx } = createPublicContext();
    const caller = appRouter.createCaller(ctx);

    const result = await caller.library.getFilterOptions();

    expect(result).toHaveProperty("formats");
    expect(result).toHaveProperty("styles");
    expect(result).toHaveProperty("subgenres");
    expect(result).toHaveProperty("humorFrameworks");
    expect(Array.isArray(result.formats)).toBe(true);
    expect(Array.isArray(result.styles)).toBe(true);
  });
});

describe("analytics.getBookRegistry", () => {
  it("returns an array of books with expected fields", async () => {
    const { ctx } = createPublicContext();
    const caller = appRouter.createCaller(ctx);

    const result = await caller.analytics.getBookRegistry();

    expect(Array.isArray(result)).toBe(true);

    if (result.length > 0) {
      const book = result[0];
      expect(book).toHaveProperty("isbn");
      expect(book).toHaveProperty("title");
      expect(book).toHaveProperty("author");
      expect(book).toHaveProperty("appearanceCount");
      expect(book).toHaveProperty("latestScore");
      expect(book).toHaveProperty("latestSocialMomentum");
      expect(book).toHaveProperty("latestDesignNovelty");
      expect(book).toHaveProperty("latestAudienceSize");
      expect(book).toHaveProperty("winnerConceptCount");
      expect(typeof book.appearanceCount).toBe("number");
      expect(book.appearanceCount).toBeGreaterThan(0);
    }
  });
});

describe("analytics.getBookTrends", () => {
  it("returns trend data for a known book ISBN", async () => {
    const { ctx } = createPublicContext();
    const caller = appRouter.createCaller(ctx);

    // First get the registry to find a valid ISBN
    const registry = await caller.analytics.getBookRegistry();

    if (registry.length > 0) {
      const isbn = registry[0].isbn;
      const result = await caller.analytics.getBookTrends({ isbn });

      expect(result).toHaveProperty("dataPoints");
      expect(Array.isArray(result.dataPoints)).toBe(true);

      if (result.dataPoints.length > 0) {
        const dp = result.dataPoints[0];
        expect(dp).toHaveProperty("runDate");
        expect(dp).toHaveProperty("trendScoreTotal");
        expect(dp).toHaveProperty("socialMomentum");
        expect(dp).toHaveProperty("designNovelty");
        expect(dp).toHaveProperty("audienceSize");
        expect(dp).toHaveProperty("conceptCount");
      }
    }
  });

  it("returns empty data for unknown ISBN", async () => {
    const { ctx } = createPublicContext();
    const caller = appRouter.createCaller(ctx);

    const result = await caller.analytics.getBookTrends({
      isbn: "0000000000000",
    });

    expect(result.dataPoints).toHaveLength(0);
  });

  it("respects days filter", async () => {
    const { ctx } = createPublicContext();
    const caller = appRouter.createCaller(ctx);

    const registry = await caller.analytics.getBookRegistry();

    if (registry.length > 0) {
      const isbn = registry[0].isbn;
      const result30 = await caller.analytics.getBookTrends({ isbn, days: 30 });
      const resultAll = await caller.analytics.getBookTrends({ isbn });

      // 30-day result should have <= all-time result
      expect(result30.dataPoints.length).toBeLessThanOrEqual(resultAll.dataPoints.length);
    }
  });
});

describe("concepts.exportProduction", () => {
  it("returns error for non-existent concept", async () => {
    const { ctx } = createAuthContext();
    const caller = appRouter.createCaller(ctx);

    const result = await caller.concepts.exportProduction({
      conceptId: 999999,
      variation: "A",
    });

    expect(result.success).toBe(false);
    expect(result.message).toBe("Concept not found.");
  });
});

describe("books.getRefreshStatus", () => {
  it("returns idle status for a book not being refreshed", async () => {
    const { ctx } = createPublicContext();
    const caller = appRouter.createCaller(ctx);

    const result = await caller.books.getRefreshStatus({ bookId: 1 });

    expect(result).toHaveProperty("status");
    expect(result).toHaveProperty("progress");
    // When not refreshing, should be idle
    expect(result.status).toBe("Idle");
    expect(result.progress).toBe(0);
  });
});
