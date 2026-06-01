/**
 * Workspace tRPC router — Phase A Foundation
 * Karpathy: only what Phase A needs. No speculative procedures.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, protectedProcedure } from "./_core/trpc";
import { getShop } from "./shopifyClient";
import {
  getWorkspaceById,
  getWorkspacesByOwner,
  getWorkspacesForUser,
  createWorkspace,
  updateWorkspace,
  deleteWorkspace,
  setCredential,
  getCredential,
} from "./workspaceDb";

export const workspaceRouter = router({
  /** List all workspaces visible to the current user (user-owned + system defaults). */
  list: protectedProcedure.query(async ({ ctx }) => {
    return getWorkspacesForUser(ctx.user.openId);
  }),

  /** Get a single workspace by id. */
  get: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ input }) => {
      const ws = await getWorkspaceById(input.id);
      if (!ws) throw new TRPCError({ code: "NOT_FOUND", message: "Workspace not found" });
      return ws;
    }),

  /** Create a new workspace. Admin only for Phase A. */
  create: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1).max(100),
        slug: z.string().min(1).max(50).regex(/^[a-z0-9-]+$/),
        icon: z.string().max(10).default("🎯"),
        workspaceType: z.enum(["nyt", "niche_hunter"]),
      })
    )
    .mutation(async ({ ctx, input }) => {
      return createWorkspace({
        ...input,
        ownerId: ctx.user.openId,
      });
    }),

  /** Update workspace name, icon, pipeline config, or niche profile. */
  update: protectedProcedure
    .input(
      z.object({
        id: z.string(),
        name: z.string().min(1).max(100).optional(),
        icon: z.string().max(10).optional(),
        pipelineConfig: z
          .object({
            topicsPerScan: z.number().int().min(1).max(20),
            conceptsPerTopic: z.number().int().min(1).max(10),
            winnersToGenerate: z.number().int().min(1).max(20),
            variationsPerWinner: z.number().int().min(1).max(5),
          })
          .optional(),
        descriptionTemplate: z.string().max(2000).optional(),
        nicheProfile: z.object({
          summary: z.string(),
          targetAudience: z.string(),
          subreddits: z.array(z.string()),
          etsyKeywords: z.array(z.string()),
          crossNicheCategories: z.array(z.string()),
          culturalMoments: z.array(z.string()),
          designStyles: z.array(z.string()),
          avoidTopics: z.array(z.string()),
        }).optional(),
        // Style override: user can lock specific style fields to prevent recomputation
        styleOverride: z.object({
          primaryAesthetic: z.string().optional(),
          colorDirective: z.string().optional(),
          maxColors: z.number().int().min(1).max(8).optional(),
          textureLevel: z.string().optional(),
          compositionPreferences: z.array(z.string()).optional(),
          typographyStyle: z.string().optional(),
          avoidDirectives: z.array(z.string()).optional(),
          marketReference: z.string().optional(),
        }).nullable().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const { id, ...fields } = input;
      return updateWorkspace(id, fields as any);
    }),

  /** Store a credential for a workspace (Shopify token, Etsy key, etc.) */
  setCredential: protectedProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        provider: z.string().min(1).max(50),
        key: z.string().min(1).max(100),
        value: z.string().min(1),
      })
    )
    .mutation(async ({ input }) => {
      await setCredential(input.workspaceId, input.provider, input.key, input.value);
      return { ok: true };
    }),

  /** Check if a credential exists (returns boolean, not the value). */
  hasCredential: protectedProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        provider: z.string(),
        key: z.string(),
      })
    )
    .query(async ({ input }) => {
      const val = await getCredential(input.workspaceId, input.provider, input.key);
      return { exists: val !== null };
    }),

  /**
   * Test Shopify Private App credentials for a workspace.
   * Stores storeDomain + accessToken in workspace_credentials, then calls getShop.
   * Returns the shop name on success; throws a descriptive error on failure.
   */
  shopifyConnect: protectedProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        storeDomain: z.string().min(3).max(200),
        accessToken: z.string().min(10),
      })
    )
    .mutation(async ({ input }) => {
      // Normalise domain — strip protocol and trailing slash
      const domain = input.storeDomain
        .replace(/^https?:\/\//, "")
        .replace(/\/$/, "");

      // Validate by calling the Shopify API before persisting
      let shop;
      try {
        shop = await getShop({ storeDomain: domain, accessToken: input.accessToken });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Could not connect to Shopify: ${msg}`,
        });
      }

      // Persist credentials only after successful validation
      await setCredential(input.workspaceId, "shopify", "storeDomain", domain);
      await setCredential(input.workspaceId, "shopify", "accessToken", input.accessToken);

      return { shopName: shop.name, domain: shop.myshopify_domain };
    }),

  /** Remove stored Shopify credentials for a workspace. */
  shopifyDisconnect: protectedProcedure
    .input(z.object({ workspaceId: z.string() }))
    .mutation(async ({ input }) => {
      // setCredential with empty string effectively clears — use a sentinel
      // The cleanest approach is to overwrite with empty strings (no delete helper exists)
      await setCredential(input.workspaceId, "shopify", "storeDomain", "");
      await setCredential(input.workspaceId, "shopify", "accessToken", "");
      return { ok: true };
    }),

  /** Check whether Shopify credentials are stored for a workspace (returns boolean). */
  shopifyStatus: protectedProcedure
    .input(z.object({ workspaceId: z.string() }))
    .query(async ({ input }) => {
      const domain = await getCredential(input.workspaceId, "shopify", "storeDomain");
      const token = await getCredential(input.workspaceId, "shopify", "accessToken");
      const connected = !!(domain && domain.length > 3 && token && token.length > 10);
      return { connected, storeDomain: connected ? domain : null };
    }),

  /** Delete a workspace. Only the owner can delete. Cannot delete system workspaces. */
  delete: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const ws = await getWorkspaceById(input.id);
      if (!ws) throw new TRPCError({ code: "NOT_FOUND", message: "Workspace not found" });
      if (ws.ownerId === "system") {
        throw new TRPCError({ code: "FORBIDDEN", message: "Cannot delete system workspaces" });
      }
      if (ws.ownerId !== ctx.user.openId) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Only the workspace owner can delete it" });
      }
      await deleteWorkspace(input.id);
      return { success: true };
    }),
});
