/**
 * Niche Hunter Router Tests — Phase E
 * Tests: triggerScan, getScanStatus, getPatterns, approvePattern, dismissPattern
 */
import { describe, expect, it } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

type AuthenticatedUser = NonNullable<TrpcContext["user"]>;

function createAuthContext(openId = "test-niche-user"): { ctx: TrpcContext } {
  const user: AuthenticatedUser = {
    id: 1,
    openId,
    email: "niche@example.com",
    name: "Niche Tester",
    loginMethod: "manus",
    role: "user",
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSignedIn: new Date(),
  };

  const ctx: TrpcContext = {
    user,
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { clearCookie: () => {} } as TrpcContext["res"],
  };

  return { ctx };
}

describe("nicheHunter.getScanStatus", () => {
  it("returns status=none when no scan exists for a brand-new workspace", async () => {
    const { ctx } = createAuthContext();
    const caller = appRouter.createCaller(ctx);

    const result = await caller.nicheHunter.getScanStatus({
      workspaceId: "non-existent-workspace-xyz",
    });

    expect(result.status).toBe("none");
    expect(result.progress).toBe(0);
    expect(result.patternsFound).toBe(0);
    expect(result.scanId).toBeNull();
  });
});

describe("nicheHunter.getPatterns", () => {
  it("returns an empty array for a workspace with no patterns", async () => {
    const { ctx } = createAuthContext();
    const caller = appRouter.createCaller(ctx);

    const patterns = await caller.nicheHunter.getPatterns({
      workspaceId: "non-existent-workspace-xyz",
    });

    expect(Array.isArray(patterns)).toBe(true);
    expect(patterns.length).toBe(0);
  });

  it("accepts optional status filter without error", async () => {
    const { ctx } = createAuthContext();
    const caller = appRouter.createCaller(ctx);

    const discovered = await caller.nicheHunter.getPatterns({
      workspaceId: "non-existent-workspace-xyz",
      status: "discovered",
    });
    expect(Array.isArray(discovered)).toBe(true);

    const approved = await caller.nicheHunter.getPatterns({
      workspaceId: "non-existent-workspace-xyz",
      status: "approved",
    });
    expect(Array.isArray(approved)).toBe(true);
  });
});

describe("nicheHunter.triggerScan", () => {
  it("throws NOT_FOUND when workspace does not exist", async () => {
    const { ctx } = createAuthContext();
    const caller = appRouter.createCaller(ctx);

    await expect(
      caller.nicheHunter.triggerScan({ workspaceId: "does-not-exist" })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("throws BAD_REQUEST when workspace is type=nyt (not niche_hunter)", async () => {
    const { ctx } = createAuthContext();
    const caller = appRouter.createCaller(ctx);

    // The default NYT workspace has type='nyt'
    const workspaces = await caller.workspace.list();
    const nytWs = workspaces.find((w) => w.workspaceType === "nyt");
    if (!nytWs) return; // Skip if no NYT workspace in test DB

    await expect(
      caller.nicheHunter.triggerScan({ workspaceId: nytWs.id })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("nicheHunter.approvePattern + dismissPattern", () => {
  it("approvePattern and dismissPattern succeed silently for non-existent IDs (idempotent update)", async () => {
    const { ctx } = createAuthContext();
    const caller = appRouter.createCaller(ctx);

    // These update 0 rows but should not throw
    const approveResult = await caller.nicheHunter.approvePattern({
      patternId: "non-existent-pattern-id",
      workspaceId: "non-existent-workspace-xyz",
    });
    expect(approveResult.success).toBe(true);

    const dismissResult = await caller.nicheHunter.dismissPattern({
      patternId: "non-existent-pattern-id",
    });
    expect(dismissResult.success).toBe(true);
  });
});
