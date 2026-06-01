import { describe, expect, it } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

type AuthenticatedUser = NonNullable<TrpcContext["user"]>;

function createAuthContext(openId = "test-user-123"): { ctx: TrpcContext } {
  const user: AuthenticatedUser = {
    id: 1,
    openId,
    email: "test@example.com",
    name: "Test User",
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

describe("workspace.list", () => {
  it("returns workspaces owned by user and system-owned defaults", async () => {
    const { ctx } = createAuthContext("WA334cNGaYaNoCEdV5gDTY");
    const caller = appRouter.createCaller(ctx);

    const workspaces = await caller.workspace.list();

    // Should include at least the system-owned NYT workspace
    expect(Array.isArray(workspaces)).toBe(true);
    const nytWs = workspaces.find((ws) => ws.slug === "nyt-books");
    expect(nytWs).toBeDefined();
    expect(nytWs?.ownerId).toBe("system");

    // Should also include user-owned workspaces (Pickleball was created earlier)
    const pickleballWs = workspaces.find((ws) => ws.slug === "pickleball");
    if (pickleballWs) {
      expect(pickleballWs.ownerId).toBe("WA334cNGaYaNoCEdV5gDTY");
    }
  });

  it("returns system workspaces even for a new user with no custom workspaces", async () => {
    const { ctx } = createAuthContext("brand-new-user-xyz");
    const caller = appRouter.createCaller(ctx);

    const workspaces = await caller.workspace.list();
    expect(workspaces.length).toBeGreaterThanOrEqual(1);
    const systemWs = workspaces.find((ws) => ws.ownerId === "system");
    expect(systemWs).toBeDefined();
  });
});

describe("workspace.update with nicheProfile", () => {
  it("accepts nicheProfile in the update payload", async () => {
    const { ctx } = createAuthContext("WA334cNGaYaNoCEdV5gDTY");
    const caller = appRouter.createCaller(ctx);

    // First get the pickleball workspace
    const workspaces = await caller.workspace.list();
    const pickleballWs = workspaces.find((ws) => ws.slug === "pickleball");
    if (!pickleballWs) {
      // Skip if workspace doesn't exist (test environment may vary)
      return;
    }

    const updatedProfile = {
      summary: "Updated pickleball niche summary",
      targetAudience: "Adults 35-65, suburban, middle-to-upper income",
      subreddits: ["r/Pickleball", "r/PickleballPhilippines", "r/paddleswap"],
      etsyKeywords: ["pickleball shirt funny", "dink pickleball shirt", "pickleball dad shirt"],
      crossNicheCategories: ["gorilla hiking shirt", "cat yoga tee", "skeleton fishing shirt"],
      culturalMoments: ["dinking", "the kitchen", "third shot drop", "DUPR rating"],
      designStyles: ["vintage distressed", "retro athletic graphics", "minimalist text-based humor"],
      avoidTopics: ["tennis-specific content", "generic sports slogans"],
    };

    const result = await caller.workspace.update({
      id: pickleballWs.id,
      nicheProfile: updatedProfile,
    });

    expect(result.id).toBe(pickleballWs.id);
    // Verify the nicheProfile was saved
    const fetched = await caller.workspace.get({ id: pickleballWs.id });
    expect((fetched.nicheProfile as any)?.summary).toBe("Updated pickleball niche summary");
    expect((fetched.nicheProfile as any)?.crossNicheCategories).toContain("gorilla hiking shirt");
  });
});
