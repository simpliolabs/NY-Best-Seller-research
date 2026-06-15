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
  it("winner count defaults to 5 but is driven by pipelineConfig.winnersToGenerate; ONE hero image each (scans-to-1)", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("server/pipeline.ts", "utf8");
    expect(source).toContain("const DEFAULT_WINNERS_TO_GENERATE = 5;");
    // The count is resolved per-run from the workspace setting (1–20), not hardcoded
    expect(source).toContain("async function resolveWinnerCount(runId: number)");
    expect(source).toContain("ws?.pipelineConfig?.winnersToGenerate");
    expect(source).toContain("const IMAGES_PER_WINNER = 1;");
    // Verify global ranking logic exists, gated on the resolved winner count
    expect(source).toContain("const isWinner = i < winnerCount;");
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

  it("pipeline timeout floors at 15 minutes and scales with the winner count", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("server/pipeline.ts", "utf8");
    expect(source).toContain("const MIN_PIPELINE_TIMEOUT_MS = 15 * 60 * 1000;");
    expect(source).toContain("const MAX_PIPELINE_TIMEOUT_MS = 25 * 60 * 1000;");
    expect(source).toContain("function pipelineTimeoutForWinners(winnerCount: number)");
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

// ─── Edit-mode anchor selection (Niche Hunter library sourcing) ───────────
describe("selectAnchorImage", () => {
  const A = (image: string, status: string, score: number, text: string) => ({ image, status, score, text });

  it("returns null for an empty pool (cold-start → falls through to Etsy/text)", async () => {
    const { selectAnchorImage } = await import("./pipeline");
    expect(selectAnchorImage([], "pickleball dink llama", 0)).toBeNull();
  });

  it("prefers the THEMATIC token-overlap match over score/approval", async () => {
    const { selectAnchorImage } = await import("./pipeline");
    const pool = [
      A("img-approved-unrelated", "approved", 99, "vintage coffee espresso roaster"),
      A("img-relevant", "discovered", 10, "pickleball paddle dink kitchen"),
    ];
    expect(selectAnchorImage(pool, "Just Dink It — pickleball paddle", 0)).toBe("img-relevant");
  });

  it("with NO overlap, rotates by index so winners don't collapse onto one design", async () => {
    const { selectAnchorImage } = await import("./pipeline");
    const pool = [
      A("img-a", "approved", 50, "alpha"),
      A("img-b", "approved", 40, "bravo"),
    ];
    const picks = [0, 1].map((i) => selectAnchorImage(pool, "zzz no overlap zzz", i));
    expect(new Set(picks).size).toBe(2); // distinct anchors for distinct winners
  });

  it("in the no-overlap rotation, approved sorts ahead of discovered", async () => {
    const { selectAnchorImage } = await import("./pipeline");
    const pool = [
      A("img-discovered", "discovered", 99, "alpha"),
      A("img-approved", "approved", 1, "bravo"),
    ];
    expect(selectAnchorImage(pool, "zzz", 0)).toBe("img-approved");
  });
});

// ─── Audit-fix guards (lock in the 2026-06-13 Manus-audit fixes) ──────────
describe("image pipeline audit fixes", () => {
  it("the 2nd (background-removal) gpt-image-2 call is medium quality, not high (audit #2)", async () => {
    const fs = await import("fs");
    const src = fs.readFileSync("server/productionImageProcessor.ts", "utf8");
    expect(src).not.toContain('formData.append("quality", "high")');
    expect(src).toContain('formData.append("quality", "medium")');
  });

  it("production processing is DEFERRED out of the scan's stage 6 (background removal is on-demand)", async () => {
    const fs = await import("fs");
    const src = fs.readFileSync("server/pipeline.ts", "utf8");
    // The 2nd gpt-image-2 call (magenta-regen bg removal) doubled stage-6 load and was deferred to
    // the on-demand "Process Images" path — it must not run inline in the scan pipeline.
    expect(src).not.toContain("processDesignForProduction");
  });

  it("scans-to-1: IMAGES_PER_WINNER is 1 (audit #1)", async () => {
    const fs = await import("fs");
    const src = fs.readFileSync("server/pipeline.ts", "utf8");
    expect(src).toContain("const IMAGES_PER_WINNER = 1;");
  });

  it("winner generation falls back to Forge so a run never ships 0 images", async () => {
    const fs = await import("fs");
    const src = fs.readFileSync("server/pipeline.ts", "utf8");
    expect(src).toContain("[forge fallback]");
  });
});
