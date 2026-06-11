/**
 * Workspace tRPC router — Phase A Foundation
 * Karpathy: only what Phase A needs. No speculative procedures.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, protectedProcedure } from "./_core/trpc";
import {
  getWorkspaceById,
  getWorkspacesByOwner,
  getWorkspacesForUser,
  createWorkspace,
  updateWorkspace,
  setWorkspaceAllowedStyles,
  deleteWorkspace,
  setCredential,
  getCredential,
} from "./workspaceDb";
import { DEFAULT_ALLOWED_STYLES } from "../shared/styleProfile";

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
          /** General best-seller search terms for the product type (e.g. "funny shirt", "graphic tee") */
          generalBestSellerTerms: z.array(z.string()).optional(),
          culturalMoments: z.array(z.string()),
          designStyles: z.array(z.string()),
          avoidTopics: z.array(z.string()),
          culturalMap: z.object({
            animalMascots: z.array(z.object({ animal: z.string(), whyItWorks: z.string(), visualTreatment: z.string() })),
            painPoints: z.array(z.object({ pain: z.string(), humorAngle: z.string() })),
            funPoints: z.array(z.object({ joy: z.string(), visualConcept: z.string() })),
            insideJokes: z.array(z.object({ joke: z.string(), context: z.string() })),
            physicalComedy: z.array(z.object({ scenario: z.string(), whyFunny: z.string() })),
            catchphrases: z.array(z.string()),
            lifestyleIdentity: z.array(z.object({ trait: z.string(), purchaseDriver: z.string() })),
            rivalries: z.array(z.object({ rivalry: z.string(), tension: z.string(), humorAngle: z.string() })),
            transferableVisualConcepts: z.array(z.object({ sourceNiche: z.string(), sourcePattern: z.string(), targetAdaptation: z.string(), whyItTransfers: z.string() })),
          }).optional(),
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

  /** Curate the per-workspace art-style allowlist the concept council picks each concept's style
   *  from (cartoonish stays excluded by convention — it's never offered in the UI). */
  setAllowedStyles: protectedProcedure
    .input(z.object({
      id: z.string(),
      allowedStyles: z.array(z.string().min(1).max(100)).min(1).max(40),
    }))
    .mutation(async ({ input }) => {
      return setWorkspaceAllowedStyles(input.id, input.allowedStyles);
    }),

  /** The canonical art-style menu — single source of truth for the Settings "Design Styles" pills
   *  AND the per-concept Regenerate dropdown. Frontend renders from this, so adding/removing a
   *  style is a BACKEND-ONLY change (edit DEFAULT_ALLOWED_STYLES; both pickers update). */
  styleOptions: protectedProcedure.query(() => {
    return DEFAULT_ALLOWED_STYLES;
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
   * Save Shopify OAuth app credentials (Client ID + Secret) for a workspace.
   * These are used by the /api/shopify/auth + /api/shopify/callback OAuth flow.
   */
  shopifySaveCredentials: protectedProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        clientId: z.string().min(5),
        clientSecret: z.string().min(5),
        storeDomain: z.string().min(3).max(200),
      })
    )
    .mutation(async ({ input }) => {
      const domain = input.storeDomain
        .replace(/^https?:\/\//, "")
        .replace(/\/$/, "");

      await setCredential(input.workspaceId, "shopify", "clientId", input.clientId);
      await setCredential(input.workspaceId, "shopify", "clientSecret", input.clientSecret);
      await setCredential(input.workspaceId, "shopify", "pendingDomain", domain);

      return { ok: true };
    }),

  /** Remove stored Shopify credentials for a workspace. */
  shopifyDisconnect: protectedProcedure
    .input(z.object({ workspaceId: z.string() }))
    .mutation(async ({ input }) => {
      await setCredential(input.workspaceId, "shopify", "storeDomain", "");
      await setCredential(input.workspaceId, "shopify", "accessToken", "");
      await setCredential(input.workspaceId, "shopify", "clientId", "");
      await setCredential(input.workspaceId, "shopify", "clientSecret", "");
      await setCredential(input.workspaceId, "shopify", "oauthNonce", "");
      await setCredential(input.workspaceId, "shopify", "pendingDomain", "");
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
