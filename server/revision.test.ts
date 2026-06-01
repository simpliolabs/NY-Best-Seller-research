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
  it("includes concept metadata and instruction in the prompt", () => {
    const prompt = buildRevisionPrompt(
      "Make the text bolder",
      {
        conceptName: "Dragon Fire",
        format: "badge",
        style: "vintage",
        headline: "BURN BRIGHT",
        subtext: "Never fade",
      },
      "A"
    );

    expect(prompt).toContain("Dragon Fire");
    expect(prompt).toContain("badge");
    expect(prompt).toContain("vintage");
    expect(prompt).toContain("BURN BRIGHT");
    expect(prompt).toContain("Never fade");
    expect(prompt).toContain("Make the text bolder");
    expect(prompt).toContain("Variation: A");
    expect(prompt).toContain("Clean/Commercial");
  });

  it("handles variation B label correctly", () => {
    const prompt = buildRevisionPrompt(
      "Add texture",
      { conceptName: "Test", format: "arch", style: "modern" },
      "B"
    );
    expect(prompt).toContain("Bold/Artistic");
    expect(prompt).toContain("Variation: B");
  });

  it("handles variation C label correctly", () => {
    const prompt = buildRevisionPrompt(
      "Add texture",
      { conceptName: "Test", format: "arch", style: "modern" },
      "C"
    );
    expect(prompt).toContain("Trending/Social");
    expect(prompt).toContain("Variation: C");
  });

  it("omits headline/subtext when null", () => {
    const prompt = buildRevisionPrompt(
      "Change colors",
      {
        conceptName: "Minimal",
        format: "diamond",
        style: "clean",
        headline: null,
        subtext: null,
      },
      "A"
    );
    expect(prompt).not.toContain("Headline:");
    expect(prompt).not.toContain("Subtext:");
  });

  it("includes DTF silhouette constraint", () => {
    const prompt = buildRevisionPrompt(
      "Any instruction",
      { conceptName: "Test", format: "badge", style: "retro" },
      "A"
    );
    expect(prompt).toContain("DTF Silhouette Rule");
    expect(prompt).toContain("NO solid background fills");
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
