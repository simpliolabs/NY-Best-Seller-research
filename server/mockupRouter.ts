/**
 * Mockup Router — Phase H
 * Procedures: generate, getMockups, regenerate, getColorMatches
 * Karpathy: only what's needed, no speculative endpoints.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, protectedProcedure } from "./_core/trpc";
import { compositeDesignOnMockup, anchorForProductType, resolvePrintZone } from "./mockupCompositor";
import { pickBestColors } from "./mockupColorMatcher";
import { processDesignForProduction } from "./productionImageProcessor";
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
      const imagePromptKey = `imagePrompt${input.variationKey}` as "imagePromptA" | "imagePromptB" | "imagePromptC";

      // Prefer the production (clean, transparent, content-cropped) design. If it doesn't exist
      // yet, AUTO-PROCESS the raw image into a clean cutout NOW (PO 2026-06-09). Why this matters:
      // compositing the RAW image relies on composite-time background-removal that is unreliable
      // on colored/scene backgrounds — it leaves the design un-cropped, so contain-fit places a
      // padded canvas and the visible art lands OFF-CENTER + over/undersized. A production cutout
      // is content-cropped + centered, so it fills the print zone correctly. processDesignForProduction
      // caches its result to productionUrl* (updateConceptProductionUrl), so this runs at most once
      // per variation; on failure we fall back to the raw image (degraded, but never blocks).
      // Manual uploads (PO 2026-06-15 bug #1): always RE-DERIVE locally — never trust a cached
      // productionUrl the old AI-regen path may have filled with regenerated/wrong art, and never
      // re-run the gpt-image-2 regen. This self-heals manual designs broken by the prior path.
      const isManual = concept.format === "Manual";
      let designUrl: string | null | undefined = isManual ? null : concept[productionUrlKey];
      let isProductionReady = !!designUrl;
      if (designUrl) {
        console.log(`[Mockup] Using production (transparent) URL for concept ${input.conceptId} variation ${input.variationKey}`);
      } else {
        const rawUrl = concept[imageUrlKey];
        if (!rawUrl) {
          throw new TRPCError({ code: "BAD_REQUEST", message: `No image found for variation ${input.variationKey}` });
        }
        try {
          const promptDesc = concept[imagePromptKey] || `${concept.conceptName || "design"} in ${concept.style || "graphic tee"} style`;
          console.log(`[Mockup] ${isManual ? "Manual upload" : `No productionUrl${input.variationKey}`} for concept ${input.conceptId} — processing the design into a clean transparent cutout…`);
          designUrl = await processDesignForProduction(rawUrl, input.conceptId, input.variationKey, promptDesc, isManual);
          isProductionReady = true;
          console.log(`[Mockup] Auto-process complete → ${designUrl}`);
        } catch (err) {
          console.warn(`[Mockup] Auto-process FAILED for concept ${input.conceptId} variation ${input.variationKey}; falling back to the raw image (placement may be off-center / imperfect):`, err);
          designUrl = rawUrl;
          isProductionReady = false;
        }
      }
      if (!designUrl) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `No image found for variation ${input.variationKey}` });
      }

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

      // 4. PER-TEMPLATE print area (PO 2026-06-09): each color template carries its OWN
      // calibrated box (template.garmentBbox, repurposed as that color's print rectangle),
      // resolved per-iteration below. Falls back to the group's shared zone, then DEFAULT —
      // so legacy single-zone groups keep working until each color is recalibrated.
      const hasGroupZone = !!group.printZone;
      // Per-type vertical anchor (group-level): apparel = centered-to-top, objects = centered.
      const anchorY = anchorForProductType(group.productType);
      if (!hasGroupZone && !templates.some((t) => !!t.garmentBbox)) {
        console.warn(`[Mockup] Product group ${input.productGroupId} has NO per-template or group print zone — using DEFAULT. Calibrate a print area per color for precise placement.`);
      }

      // 4c. Capture the prior render set for this concept+variation. We DELETE it only AFTER new
      // renders succeed (below) so "Generate Mockups" REPLACES the set instead of accumulating
      // stale duplicates — without risking data loss if compositing fails. (PO: regenerate kept
      // showing the same old off-center renders because createMockupRender only ever inserts.)
      const priorRenders = await getMockupsByConceptVariation(input.conceptId, input.variationKey);

      // 5. Composite each template and store result
      // Per-DESIGN placement (concept.printPlacements[groupId], set in the Mockup studio) wins over
      // the group's per-colour calibration — it's scoped to THIS concept and never mutates the group.
      const conceptPlacement = (concept.printPlacements as Record<string, { x: number; y: number; width: number; height: number }> | null)?.[input.productGroupId] ?? null;
      const renders = [];
      let failedCount = 0;
      for (const template of templates) {
        try {
          // Concept placement > per-template box > group zone > DEFAULT (resolvePrintZone is total).
          const printZone = resolvePrintZone(conceptPlacement ?? template.garmentBbox ?? null, group.printZone ?? null);
          const compositeBuffer = await compositeDesignOnMockup({
            designUrl,
            mockupUrl: template.imageUrl,
            printZone,
            anchorY,
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
          // Log but continue — don't fail the whole batch for one template. Count it (PO 2026-06-15
          // bug #1) so the UI can say "3 of 5 templates failed" instead of silently making fewer.
          failedCount++;
          console.error(`[Mockup] Failed to composite template ${template.id}:`, err);
        }
      }

      // 5b. Fresh renders exist → remove the prior set (REPLACE semantics so the UI updates
      // instead of showing stale renders). Guarded on success so a total failure never wipes
      // the previous good renders.
      if (renders.length > 0 && priorRenders.length > 0) {
        for (const pr of priorRenders) {
          await deleteMockupRender(pr.id);
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
          return { success: true, mockupCount: renders.length, renders, qualityCheck: qa, usedDefaultZone: !hasGroupZone, productionReady: isProductionReady, failedCount };
        } catch (qaErr) {
          console.warn("[Mockup QA] Vision check failed (non-blocking):", qaErr);
        }
      }

      return { success: true, mockupCount: renders.length, renders, qualityCheck: null, usedDefaultZone: !hasGroupZone, productionReady: isProductionReady, failedCount };
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

  /** Per-DESIGN Manual Placement (PO 2026-06-12): save/clear the print box for THIS concept on THIS
   *  product group. Replaces the old setManualPlacementAllColors flow from the Mockup studio, which
   *  overwrote the group's per-colour calibration (the "Product Group changes not persistent" bug).
   *  printArea null = clear (generate falls back to the group calibration). */
  setConceptPlacement: protectedProcedure
    .input(z.object({
      conceptId: z.number(),
      productGroupId: z.string(),
      printArea: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).nullable(),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const rows = await db.select({ printPlacements: designConcepts.printPlacements })
        .from(designConcepts).where(eq(designConcepts.id, input.conceptId)).limit(1);
      if (!rows[0]) throw new TRPCError({ code: "NOT_FOUND", message: "Concept not found" });
      const map = { ...(rows[0].printPlacements as Record<string, unknown> | null ?? {}) };
      if (input.printArea === null) delete map[input.productGroupId];
      else map[input.productGroupId] = input.printArea;
      await db.update(designConcepts).set({ printPlacements: map as any }).where(eq(designConcepts.id, input.conceptId));
      return { ok: true, cleared: input.printArea === null };
    }),

  /** The saved per-design placement for a concept+group (drives the "(active)" button state). */
  getConceptPlacement: protectedProcedure
    .input(z.object({ conceptId: z.number(), productGroupId: z.string() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return null;
      const rows = await db.select({ printPlacements: designConcepts.printPlacements })
        .from(designConcepts).where(eq(designConcepts.id, input.conceptId)).limit(1);
      const map = rows[0]?.printPlacements as Record<string, { x: number; y: number; width: number; height: number }> | null;
      return map?.[input.productGroupId] ?? null;
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
