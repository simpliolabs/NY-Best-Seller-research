/**
 * Revision Phase G — Tests
 * Tests buildRevisionPrompt (unit) and router procedures (integration).
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { buildRevisionPrompt } from "./revisionEngine";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

// ─── Test helpers ──────────────────────────────────────────────────────────
function createAuthContext(): TrpcContext {
  return {
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
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { clearCookie: vi.fn() } as unknown as TrpcContext["res"],
  };
}

function createPublicContext(): TrpcContext {
  return {
    user: null,
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { clearCookie: vi.fn() } as unknown as TrpcContext["res"],
  };
}

// ─── Unit: buildRevisionPrompt ─────────────────────────────────────────────
describe("buildRevisionPrompt", () => {
  const meta = { conceptName: "Dragon Fire", format: "badge", style: "vintage", headline: "BURN BRIGHT", subtext: "Never fade" };

  it("embeds the user instruction verbatim", () => {
    const prompt = buildRevisionPrompt("change YEE to HAW", meta, "A");
    expect(prompt).toContain("change YEE to HAW");
  });

  it("locks the design as a surgical edit — keep everything else pixel-for-pixel identical", () => {
    const prompt = buildRevisionPrompt("Make the text bolder", meta, "A");
    expect(prompt).toContain("SURGICAL");
    expect(prompt).toContain("pixel-for-pixel identical");
    expect(prompt).toMatch(/do NOT crop/i);
    expect(prompt).toMatch(/do NOT add, remove, recolour/i);
    expect(prompt).toMatch(/Change only what the instruction asks/i);
  });

  it("does NOT inject concept metadata or DTF redraw rules that invite recomposition", () => {
    // PO 2026-06-10: the old prompt fed concept metadata + DTF 'silhouette/redraw' rules, which let
    // a text swap recompose (cropped text + invented stripe). A faithful edit reads the IMAGE only.
    const prompt = buildRevisionPrompt("Add texture", meta, "A");
    expect(prompt).not.toContain("Dragon Fire");
    expect(prompt).not.toContain("DTF Silhouette Rule");
    expect(prompt).not.toContain("Variation:");
  });

  it("non-square aspect cites the new aspect, restricts new pixels to extra canvas space, and bakes in universal preservation", () => {
    // PO 2026-06-16: the unified non-square prompt (after the YEE HAW cut-off) must bake in
    // "everything else stays pixel-for-pixel identical" by default so the user never has to suffix
    // "keep all elements the same besides that." The ONLY thing that changes is the canvas.
    const tall = buildRevisionPrompt("extend vertically", meta, "A", "9:16");
    expect(tall).toContain("9:16");
    expect(tall).toMatch(/pixel-for-pixel/i);
    expect(tall).toMatch(/EXTRA canvas space/i); // new pixels are scoped to the extension only
    expect(tall).toMatch(/Do NOT crop/i);
    expect(tall).toMatch(/do NOT redraw|restyle|recolour|reinterpret/i);
  });
});

// ─── Integration: revisionRouter ───────────────────────────────────────────
describe("revisionRouter", () => {
  const caller = appRouter.createCaller(createAuthContext());
  const publicCaller = appRouter.createCaller(createPublicContext());

  it("getReviewQueue requires authentication", async () => {
    await expect(
      publicCaller.revision.getReviewQueue({ runId: 1 })
    ).rejects.toThrow();
  });

  it("submitRevision requires authentication", async () => {
    await expect(
      publicCaller.revision.submitRevision({
        conceptId: 1,
        variationKey: "A",
        instruction: "Make it bold",
      })
    ).rejects.toThrow();
  });

  it("getHistory requires authentication", async () => {
    await expect(
      publicCaller.revision.getHistory({ conceptId: 1, variationKey: "A" })
    ).rejects.toThrow();
  });

  it("acceptDesign requires authentication", async () => {
    await expect(
      publicCaller.revision.acceptDesign({ revisionId: "fake-id" })
    ).rejects.toThrow();
  });

  it("revertToOriginal requires authentication", async () => {
    await expect(
      publicCaller.revision.revertToOriginal({ conceptId: 1, variationKey: "A" })
    ).rejects.toThrow();
  });

  it("getHistory returns empty array for non-existent concept", async () => {
    const result = await caller.revision.getHistory({
      conceptId: 999999,
      variationKey: "A",
    });
    expect(result).toEqual([]);
  });

  it("submitRevision rejects non-existent concept", async () => {
    await expect(
      caller.revision.submitRevision({
        conceptId: 999999,
        variationKey: "A",
        instruction: "Make it bold",
      })
    ).rejects.toThrow("Concept not found");
  });

  it("acceptDesign rejects non-existent revision", async () => {
    await expect(
      caller.revision.acceptDesign({ revisionId: "nonexistent-id" })
    ).rejects.toThrow("Revision not found");
  });

  it("revertToOriginal succeeds even with no revisions", async () => {
    const result = await caller.revision.revertToOriginal({
      conceptId: 999999,
      variationKey: "A",
    });
    expect(result).toEqual({ success: true });
  });
});
