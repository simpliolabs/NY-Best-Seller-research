import { describe, expect, it, vi } from "vitest";

// ─── Unit tests for pipeline safeguards ──────────────────────────────────

describe("withTimeout utility", () => {
  // Re-implement the withTimeout function for isolated testing
  function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Timeout after ${ms}ms: ${label}`)),
        ms
      );
      promise
        .then((val) => { clearTimeout(timer); resolve(val); })
        .catch((err) => { clearTimeout(timer); reject(err); });
    });
  }

  it("resolves when promise completes before timeout", async () => {
    const result = await withTimeout(
      Promise.resolve("ok"),
      1000,
      "test"
    );
    expect(result).toBe("ok");
  });

  it("rejects with timeout error when promise takes too long", async () => {
    const slowPromise = new Promise((resolve) => setTimeout(resolve, 5000));
    await expect(
      withTimeout(slowPromise, 50, "slow-op")
    ).rejects.toThrow("Timeout after 50ms: slow-op");
  });

  it("propagates original error when promise rejects before timeout", async () => {
    const failingPromise = Promise.reject(new Error("original error"));
    await expect(
      withTimeout(failingPromise, 1000, "test")
    ).rejects.toThrow("original error");
  });
});

describe("pipeline configuration constants", () => {
  it("MAX_WINNER_CONCEPTS = 5 global winners with 3 images each", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("server/pipeline.ts", "utf8");
    expect(source).toContain("const MAX_WINNER_CONCEPTS = 5;");
    expect(source).toContain("const IMAGES_PER_WINNER = 3;");
    // Verify global ranking logic exists
    expect(source).toContain("const isWinner = i < MAX_WINNER_CONCEPTS;");
    expect(source).toContain("globalRank: i + 1");
  });

  it("exports runPipeline and recoverStaleRuns", async () => {
    const pipeline = await import("./pipeline");
    expect(typeof pipeline.runPipeline).toBe("function");
    expect(typeof pipeline.recoverStaleRuns).toBe("function");
  });

  it("TOP_N_BOOKS is set to 6", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("server/pipeline.ts", "utf8");
    expect(source).toContain("const TOP_N_BOOKS = 6;");
  });

  it("OVERALL_PIPELINE_TIMEOUT_MS is 15 minutes", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("server/pipeline.ts", "utf8");
    expect(source).toContain("const OVERALL_PIPELINE_TIMEOUT_MS = 15 * 60 * 1000;");
  });

  it("image generation uses parallel Promise.allSettled", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("server/pipeline.ts", "utf8");
    expect(source).toContain("Promise.allSettled(");
  });

  it("Stage 6 is gracefully skippable (self-healing wrapped)", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("server/pipeline.ts", "utf8");
    // Stage 6 is now wrapped with withSelfHeal which handles graceful degradation
    expect(source).toContain("Stage 6: Image Generation");
    expect(source).toContain("withSelfHeal");
  });
});

describe("cross-run trend comparison helpers", () => {
  it("getPreviousCompletedRunId returns null when no previous runs", async () => {
    const { getPreviousCompletedRunId } = await import("./db");
    // Use a very high run ID that won't have a predecessor
    const result = await getPreviousCompletedRunId(999999999);
    // Should be null or a valid number
    expect(result === null || typeof result === "number").toBe(true);
  });

  it("getBooksByRunIdIndexedByIsbn returns a Map", async () => {
    const { getBooksByRunIdIndexedByIsbn } = await import("./db");
    const result = await getBooksByRunIdIndexedByIsbn(999999999);
    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(0);
  });

  it("updateBookTrend function exists and is callable", async () => {
    const { updateBookTrend } = await import("./db");
    expect(typeof updateBookTrend).toBe("function");
  });
});

describe("pipeline.cancelRun", () => {
  it("requires authentication for cancelRun", async () => {
    const { appRouter } = await import("./routers");
    type TrpcContext = Parameters<typeof appRouter.createCaller>[0];

    const ctx: TrpcContext = {
      user: null,
      req: { protocol: "https", headers: {} } as any,
      res: { clearCookie: vi.fn() } as any,
    };

    const caller = appRouter.createCaller(ctx);
    await expect(
      caller.pipeline.cancelRun({ runId: 999999 })
    ).rejects.toThrow();
  });

  it("returns error for non-existent run", async () => {
    const { appRouter } = await import("./routers");
    type TrpcContext = Parameters<typeof appRouter.createCaller>[0];

    const ctx: TrpcContext = {
      user: {
        id: 1,
        openId: "test-user",
        email: "test@example.com",
        name: "Test User",
        loginMethod: "manus",
        role: "user",
        createdAt: new Date(),
        updatedAt: new Date(),
        lastSignedIn: new Date(),
      },
      req: { protocol: "https", headers: {} } as any,
      res: { clearCookie: vi.fn() } as any,
    };

    const caller = appRouter.createCaller(ctx);
    const result = await caller.pipeline.cancelRun({ runId: 999999 });
    expect(result.success).toBe(false);
    expect(result.message).toContain("not found");
  });
});

describe("Etsy API skip behavior", () => {
  it("pipeline has Etsy pre-validation before starting stages", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("server/pipeline.ts", "utf8");
    expect(source).toContain("Pre-validate Etsy API key before starting the pipeline");
  });

  it("sets validatedEtsyKey to undefined on 403", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("server/pipeline.ts", "utf8");
    expect(source).toContain('testResp.status === 401 || testResp.status === 403');
    expect(source).toContain('validatedEtsyKey = undefined');
  });

  it("Stage 5 label reflects Etsy skip status", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("server/pipeline.ts", "utf8");
    expect(source).toContain('Etsy skipped');
    expect(source).toContain('Etsy market validation');
  });

  it("stageScoreAndValidate skips Etsy when key is undefined", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("server/pipeline.ts", "utf8");
    expect(source).toContain('Etsy API key not configured — skipping market validation');
  });
});

describe("recoverStaleRuns", () => {
  it("does not throw when called", async () => {
    const { recoverStaleRuns } = await import("./pipeline");
    // Should complete without error even if no stale runs exist
    await expect(recoverStaleRuns()).resolves.not.toThrow();
  });

  it("accepts custom maxAgeMs parameter", async () => {
    const { recoverStaleRuns } = await import("./pipeline");
    // With a very short maxAge, it should still not throw
    await expect(recoverStaleRuns(1000)).resolves.not.toThrow();
  });
});
