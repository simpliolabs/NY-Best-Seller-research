/**
 * Mockup Router — Phase H
 * Procedures: generate, getMockups, regenerate, getColorMatches
 * Karpathy: only what's needed, no speculative endpoints.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, protectedProcedure } from "./_core/trpc";
import { compositeDesignOnMockup, DEFAULT_PRINT_AREA } from "./mockupCompositor";
import { getGarmentBbox, resolveZoneToPhoto } from "./garmentDetector";
import { pickBestColors } from "./mockupColorMatcher";
import {
  createMockupRender,
  getMockupsByConcept,
  getMockupsByConceptVariation,
  deleteMockupRender,
} from "./mockupDb";
import { getMockupsByGroup, getProductGroupById } from "./productGroupDb";
import { storagePut } from "./storage";
import { nanoid } from "nanoid";
import { getDb } from "./db";
import { designConcepts, botRuns } from "../drizzle/schema";
import { eq } from "drizzle-orm";
import { invokeLLM } from "./_core/llm";

export const mockupRouter = router({
  /**
   * Generate mockups for a concept variation on all (or best-matched) templates in a product group.
   * Input: conceptId, variationKey (A/B/C), productGroupId, optional count for color matching.
   */
  generate: protectedProcedure
    .input(
      z.object({
        conceptId: z.number(),
        variationKey: z.enum(["A", "B", "C"]),
        productGroupId: z.string(),
        colorCount: z.number().min(1).max(20).optional(),
      })
    )
    .mutation(async ({ input }) => {
      // 1. Get the concept to find the design image URL
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });

      const concepts = await db
        .select()
        .from(designConcepts)
        .where(eq(designConcepts.id, input.conceptId))
        .limit(1);
      const concept = concepts[0];
      if (!concept) throw new TRPCError({ code: "NOT_FOUND", message: "Concept not found" });

      // Get the design image URL for the specified variation.
      // Prefer productionUrl* (transparent PNG) over imageUrl* (raw generated image).
      // productionUrl* is set by processDesignForProduction after AI background removal.
      const productionUrlKey = `productionUrl${input.variationKey}` as "productionUrlA" | "productionUrlB" | "productionUrlC";
      const imageUrlKey = `imageUrl${input.variationKey}` as "imageUrlA" | "imageUrlB" | "imageUrlC";
      const designUrl = concept[productionUrlKey] || concept[imageUrlKey];
      if (!designUrl) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `No image found for variation ${input.variationKey}`,
        });
      }
      const isProductionReady = !!concept[productionUrlKey];
      console.log(`[Mockup] Using ${isProductionReady ? 'production (transparent)' : 'raw (needs bg removal)'} URL for concept ${input.conceptId} variation ${input.variationKey}`);

      // 1b. Workspace ownership guard — concept and product group must belong to same workspace
      const conceptRunRow = await db.select({ workspaceId: botRuns.workspaceId })
        .from(botRuns)
        .where(eq(botRuns.id, concept.runId))
        .limit(1);
      const conceptWorkspaceId = conceptRunRow[0]?.workspaceId;

      // 2. Get the product group and its templates
      const group = await getProductGroupById(input.productGroupId);
      if (!group) throw new TRPCError({ code: "NOT_FOUND", message: "Product group not found" });

      if (conceptWorkspaceId && group.workspaceId && conceptWorkspaceId !== group.workspaceId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Concept and product group must belong to the same workspace",
        });
      }

      let templates = await getMockupsByGroup(input.productGroupId);
      if (templates.length === 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Product group has no mockup templates. Upload blank shirt photos first.",
        });
      }

      // 3. If colorCount specified, use LLM to pick best colors
      if (input.colorCount && input.colorCount < templates.length) {
        templates = await pickBestColors(designUrl, templates, input.colorCount);
      }

      // 4. Get print area from product group (or use default).
      // Print area = max ink envelope, expressed as fractions of the GARMENT bbox (not the photo).
      const printAreaRelGarment = (group.printZone as { x: number; y: number; width: number; height: number } | null) ?? DEFAULT_PRINT_AREA;

      // 5. Composite each template and store result
      const renders = [];
      for (const template of templates) {
        try {
          // Detect garment bbox for this template (cached after first call)
          const garmentBbox = await getGarmentBbox(template.id, template.imageUrl);
          // Resolve print area from garment-relative to photo-relative
          const printZone = resolveZoneToPhoto(printAreaRelGarment, garmentBbox);

          const compositeBuffer = await compositeDesignOnMockup({
            designUrl,
            mockupUrl: template.imageUrl,
            printZone,
          });

          // Upload to S3
          const fileKey = `mockups/${input.conceptId}-${input.variationKey}-${template.id}-${nanoid(6)}.webp`;
          const { url } = await storagePut(fileKey, compositeBuffer, "image/webp");

          // Save to DB
          const render = await createMockupRender({
            conceptId: input.conceptId,
            variationKey: input.variationKey,
            templateId: template.id,
            compositeUrl: url,
          });
          renders.push(render);
        } catch (err) {
          // Log but continue — don't fail the whole batch for one template
          console.error(`[Mockup] Failed to composite template ${template.id}:`, err);
        }
      }

      // 6. Run Vision LLM quality check on first render (non-blocking)
      if (renders.length > 0) {
        const firstRender = renders[0];
        try {
          const qualityCheck = await invokeLLM({
            messages: [
              {
                role: "system",
                content: "You are a print production QA specialist. Analyze this t-shirt mockup composite and rate the quality. Check: (1) Is the design properly sized and centered on the shirt? (2) Does the design look natural on the fabric? (3) Are there any background artifacts or white halos around the design? Return JSON: {\"score\": 1-10, \"issues\": [\"issue1\", ...], \"pass\": true/false}"
              },
              {
                role: "user",
                content: [
                  { type: "text", text: "Rate this mockup composite quality:" },
                  { type: "image_url", image_url: { url: firstRender.compositeUrl, detail: "low" } }
                ]
              }
            ],
            response_format: { type: "json_object" },
          });
          const qaContent = typeof qualityCheck.choices[0]?.message?.content === "string"
            ? qualityCheck.choices[0].message.content : "{}";
          const qa = JSON.parse(qaContent);
          // Attach QA result to response
          return { success: true, mockupCount: renders.length, renders, qualityCheck: qa };
        } catch (qaErr) {
          console.warn("[Mockup QA] Vision check failed (non-blocking):", qaErr);
        }
      }

      return { success: true, mockupCount: renders.length, renders, qualityCheck: null };
    }),

  /** Get all mockup renders for a concept (all variations) */
  getMockups: protectedProcedure
    .input(z.object({ conceptId: z.number() }))
    .query(async ({ input }) => {
      return getMockupsByConcept(input.conceptId);
    }),

  /** Get mockup renders for a specific concept + variation */
  getMockupsByVariation: protectedProcedure
    .input(z.object({ conceptId: z.number(), variationKey: z.enum(["A", "B", "C"]) }))
    .query(async ({ input }) => {
      return getMockupsByConceptVariation(input.conceptId, input.variationKey);
    }),

  /** Regenerate a single mockup (re-composite with current design) */
  regenerate: protectedProcedure
    .input(z.object({ mockupId: z.string() }))
    .mutation(async ({ input }) => {
      // For now, delete the old one — the user can trigger generate again
      await deleteMockupRender(input.mockupId);
      return { success: true };
    }),

  /** Delete a single mockup render */
  deleteMockup: protectedProcedure
    .input(z.object({ mockupId: z.string() }))
    .mutation(async ({ input }) => {
      await deleteMockupRender(input.mockupId);
      return { success: true };
    }),

  /** Get best color matches for a design against a product group's templates */
  getColorMatches: protectedProcedure
    .input(
      z.object({
        conceptId: z.number(),
        variationKey: z.enum(["A", "B", "C"]),
        productGroupId: z.string(),
        count: z.number().min(1).max(20).default(5),
      })
    )
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });

      const concepts = await db
        .select()
        .from(designConcepts)
        .where(eq(designConcepts.id, input.conceptId))
        .limit(1);
      const concept = concepts[0];
      if (!concept) throw new TRPCError({ code: "NOT_FOUND", message: "Concept not found" });

      const productionUrlKey2 = `productionUrl${input.variationKey}` as "productionUrlA" | "productionUrlB" | "productionUrlC";
      const imageUrlKey = `imageUrl${input.variationKey}` as "imageUrlA" | "imageUrlB" | "imageUrlC";
      const designUrl = concept[productionUrlKey2] || concept[imageUrlKey];
      if (!designUrl) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `No image found for variation ${input.variationKey}`,
        });
      }

      const templates = await getMockupsByGroup(input.productGroupId);
      if (templates.length === 0) return [];

      return pickBestColors(designUrl, templates, input.count);
    }),
});
