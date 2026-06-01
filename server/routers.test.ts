import { describe, expect, it, vi } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

// ─── Test helpers ──────────────────────────────────────────────────────────

type AuthenticatedUser = NonNullable<TrpcContext["user"]>;

function createAuthContext(): TrpcContext {
  const user: AuthenticatedUser = {
    id: 1,
    openId: "test-user",
    email: "test@example.com",
    name: "Test User",
    loginMethod: "manus",
    role: "user",
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSignedIn: new Date(),
  };

  return {
    user,
    req: {
      protocol: "https",
      headers: {},
    } as TrpcContext["req"],
    res: {
      clearCookie: vi.fn(),
    } as unknown as TrpcContext["res"],
  };
}

function createPublicContext(): TrpcContext {
  return {
    user: null,
    req: {
      protocol: "https",
      headers: {},
    } as TrpcContext["req"],
    res: {
      clearCookie: vi.fn(),
    } as unknown as TrpcContext["res"],
  };
}

// ─── Auth procedures ──────────────────────────────────────────────────────

describe("auth.me", () => {
  it("returns null for unauthenticated user", async () => {
    const ctx = createPublicContext();
    const caller = appRouter.createCaller(ctx);
    const result = await caller.auth.me();
    expect(result).toBeNull();
  });

  it("returns user for authenticated user", async () => {
    const ctx = createAuthContext();
    const caller = appRouter.createCaller(ctx);
    const result = await caller.auth.me();
    expect(result).not.toBeNull();
    expect(result?.openId).toBe("test-user");
    expect(result?.name).toBe("Test User");
  });
});

// ─── Reports procedures (v2 enhanced) ─────────────────────────────────────

describe("reports.getLatest", () => {
  it("returns v2 structure with run, books, concepts, nicheResearch, marketValidations", async () => {
    const ctx = createPublicContext();
    const caller = appRouter.createCaller(ctx);
    const result = await caller.reports.getLatest({});

    expect(result).toHaveProperty("run");
    expect(result).toHaveProperty("books");
    expect(result).toHaveProperty("concepts");
    expect(result).toHaveProperty("nicheResearch");
    expect(result).toHaveProperty("marketValidations");
    expect(Array.isArray(result.books)).toBe(true);
    expect(Array.isArray(result.concepts)).toBe(true);
    expect(Array.isArray(result.nicheResearch)).toBe(true);
    expect(Array.isArray(result.marketValidations)).toBe(true);
  });

  it("accepts workspaceId and returns same structure", async () => {
    const ctx = createPublicContext();
    const caller = appRouter.createCaller(ctx);
    const result = await caller.reports.getLatest({ workspaceId: "ws-nyt-default" });

    expect(result).toHaveProperty("run");
    expect(Array.isArray(result.books)).toBe(true);
  });
});

describe("reports.listHistory", () => {
  it("returns an array of runs (global)", async () => {
    const ctx = createPublicContext();
    const caller = appRouter.createCaller(ctx);
    const result = await caller.reports.listHistory({});
    expect(Array.isArray(result)).toBe(true);
  });

  it("returns workspace-scoped runs when workspaceId provided", async () => {
    const ctx = createPublicContext();
    const caller = appRouter.createCaller(ctx);
    const result = await caller.reports.listHistory({ workspaceId: "ws-nyt-default" });
    expect(Array.isArray(result)).toBe(true);
    // All returned runs should belong to this workspace (or be empty)
    for (const run of result) {
      expect(run.workspaceId).toBe("ws-nyt-default");
    }
  });
});

describe("reports.getByRunId", () => {
  it("returns null run for non-existent ID with v2 structure", async () => {
    const ctx = createPublicContext();
    const caller = appRouter.createCaller(ctx);
    const result = await caller.reports.getByRunId({ runId: 999999 });

    expect(result.run).toBeNull();
    expect(result.books).toEqual([]);
    expect(result.concepts).toEqual([]);
    expect(result.nicheResearch).toEqual([]);
    expect(result.marketValidations).toEqual([]);
  });

  it("blocks cross-workspace access when workspaceId does not match", async () => {
    const ctx = createPublicContext();
    const caller = appRouter.createCaller(ctx);
    // Run 450001 belongs to ws-nyt-default; requesting with a different workspaceId should return null
    const result = await caller.reports.getByRunId({ runId: 450001, workspaceId: "wrong-workspace-id" });

    expect(result.run).toBeNull();
    expect(result.books).toEqual([]);
    expect(result.concepts).toEqual([]);
  });
});

// ─── Books procedures (v2 enhanced) ───────────────────────────────────────

describe("books.getById", () => {
  it("returns null book for non-existent ID with v2 structure", async () => {
    const ctx = createPublicContext();
    const caller = appRouter.createCaller(ctx);
    const result = await caller.books.getById({ bookId: 999999 });

    expect(result.book).toBeNull();
    expect(result.concepts).toEqual([]);
    expect(result.nicheResearch).toBeNull();
    expect(result.marketValidations).toEqual([]);
  });

  it("blocks cross-workspace access when workspaceId does not match", async () => {
    const ctx = createPublicContext();
    const caller = appRouter.createCaller(ctx);
    // Book 2 belongs to run 450001 (ws-nyt-default); requesting with a different workspaceId should return null
    const result = await caller.books.getById({ bookId: 2, workspaceId: "wrong-workspace-id" });

    expect(result.book).toBeNull();
    expect(result.concepts).toEqual([]);
  });
});

// ─── Pipeline procedures ──────────────────────────────────────────────────

describe("pipeline.getStatus", () => {
  it("returns v2 status structure with isRunning and run", async () => {
    const ctx = createPublicContext();
    const caller = appRouter.createCaller(ctx);
    const result = await caller.pipeline.getStatus();

    expect(result).toHaveProperty("isRunning");
    expect(result).toHaveProperty("run");
    expect(typeof result.isRunning).toBe("boolean");
  });
});

describe("pipeline.triggerRun", () => {
  it("requires authentication", async () => {
    const ctx = createPublicContext();
    const caller = appRouter.createCaller(ctx);
    await expect(caller.pipeline.triggerRun({ workspaceId: "ws-nyt-default" })).rejects.toThrow();
  });

  it("returns error when workspace is not found", async () => {
    const ctx = createAuthContext();
    const caller = appRouter.createCaller(ctx);
    const result = await caller.pipeline.triggerRun({ workspaceId: "ws-nonexistent-999" });
    expect(result.success).toBe(false);
    expect(result.message).toContain("Workspace not found");
  });
});

describe("pipeline.getRun", () => {
  it("returns undefined for non-existent run ID", async () => {
    const ctx = createPublicContext();
    const caller = appRouter.createCaller(ctx);
    const result = await caller.pipeline.getRun({ runId: 999999 });
    expect(result).toBeUndefined();
  });
});

// ─── Favorites procedures (v2 enhanced) ───────────────────────────────────

describe("favorites.list", () => {
  it("returns an array when called without filters", async () => {
    const ctx = createPublicContext();
    const caller = appRouter.createCaller(ctx);
    const result = await caller.favorites.list();
    expect(Array.isArray(result)).toBe(true);
  });

  it("returns an array when called with v2 filters including humorFramework", async () => {
    const ctx = createPublicContext();
    const caller = appRouter.createCaller(ctx);
    const result = await caller.favorites.list({
      format: "t-shirt",
      style: "minimal",
      subgenre: "romance",
      humorFramework: "anti-joke",
    });
    expect(Array.isArray(result)).toBe(true);
  });

  it("accepts partial filters", async () => {
    const ctx = createPublicContext();
    const caller = appRouter.createCaller(ctx);
    const result = await caller.favorites.list({
      humorFramework: "cultural-insider",
    });
    expect(Array.isArray(result)).toBe(true);
  });
});

describe("favorites.getFilterOptions", () => {
  it("returns v2 filter options including humorFrameworks", async () => {
    const ctx = createPublicContext();
    const caller = appRouter.createCaller(ctx);
    const result = await caller.favorites.getFilterOptions();

    expect(result).toHaveProperty("formats");
    expect(result).toHaveProperty("styles");
    expect(result).toHaveProperty("subgenres");
    expect(result).toHaveProperty("humorFrameworks");
    expect(Array.isArray(result.formats)).toBe(true);
    expect(Array.isArray(result.styles)).toBe(true);
    expect(Array.isArray(result.subgenres)).toBe(true);
    expect(Array.isArray(result.humorFrameworks)).toBe(true);
  });
});

describe("favorites.toggle", () => {
  it("requires authentication", async () => {
    const ctx = createPublicContext();
    const caller = appRouter.createCaller(ctx);
    await expect(caller.favorites.toggle({ conceptId: 1 })).rejects.toThrow();
  });
});
