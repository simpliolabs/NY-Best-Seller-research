/**
 * Mockup Router — Phase H
 * Procedures: generate, getMockups, regenerate, getColorMatches
 * Karpathy: only what's needed, no speculative endpoints.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, protectedProcedure } from "./_core/trpc";
import { compositeDesignOnMockup, anchorForProductType, resolvePrintZone } from "./mockupCompositor";
import { pickBestColors, scoreRendersReadability } from "./mockupColorMatcher";
import { processDesignForProduction } from "./productionImageProcessor";
import {
  createMockupRender,
  getMockupsByConcept,
  getMockupsByConceptVariation,
  deleteMockupRender,
} from "./mockupDb";
import { getMockupsByGroup, getProductGroupById, getMockupTemplatesByIds } from "./productGroupDb";
import { storagePut } from "./storage";
import { nanoid } from "nanoid";
import { getDb } from "./db";
import { designConcepts, botRuns } from "../drizzle/schema";
import type { DesignConcept } from "../drizzle/schema";
import { eq } from "drizzle-orm";
import { invokeLLM } from "./_core/llm";
import { generateHalftoneSeparation, prepareFullTonePrintFile, INK_COLORS } from "./halftone";
import type { InkName } from "./halftone";
import { createPrintFile, findPrintFileByHash, getPrintFilesByConcept } from "./printFileDb";
import { knockoutColors, hexToRgb } from "./knockout";
import { classifyDesignType } from "./designType";
import { analyzeGarmentFit } from "./garmentFit";
import { createHash } from "crypto";

const INK_NAMES = Object.keys(INK_COLORS) as [InkName, ...InkName[]];

/** Store a generated print PNG once: content-hash dedupe (reuse the stored file on an identical
 *  re-export instead of piling up duplicate 69MB PNGs), then storagePut + index into print_files so
 *  the seller can find it later (PO 2026-06-17 print-files library). Returns the persisted row's url. */
async function persistPrintFile(
  png: Buffer,
  meta: {
    conceptId: number; variationKey: "A" | "B" | "C"; sourceRevisionId?: string;
    kind: "fulltone" | "halftone" | "knockout"; inkColor?: string | null;
    filename: string; widthPx: number; heightPx: number;
  },
): Promise<{ url: string; filename: string; widthPx: number; heightPx: number; dpi: number; deduped: boolean }> {
  const contentHash = createHash("sha256").update(png).digest("hex");
  const existing = await findPrintFileByHash(meta.conceptId, contentHash);
  if (existing) {
    return { url: existing.url, filename: existing.filename, widthPx: existing.widthPx, heightPx: existing.heightPx, dpi: existing.dpi, deduped: true };
  }
  const { url } = await storagePut(`print/${meta.conceptId}-${meta.variationKey}-${nanoid(6)}-${meta.filename}`, png, "image/png");
  await createPrintFile({
    conceptId: meta.conceptId, variationKey: meta.variationKey, sourceRevisionId: meta.sourceRevisionId ?? null,
    kind: meta.kind, inkColor: meta.inkColor ?? null, url, filename: meta.filename,
    widthPx: meta.widthPx, heightPx: meta.heightPx, dpi: 300, contentHash,
  });
  return { url, filename: meta.filename, widthPx: meta.widthPx, heightPx: meta.heightPx, dpi: 300, deduped: false };
}

/** Resolve the design source URL for an export (PO 2026-06-17, print export). A specific version
 *  when sourceRevisionId is given, else the live slot: imageUrl (the design as drawn) preferred,
 *  falling back to productionUrl for legacy niche concepts whose design lives there (imageUrl null). */
async function resolveExportSourceUrl(
  concept: DesignConcept,
  variationKey: "A" | "B" | "C",
  sourceRevisionId?: string,
): Promise<string | null> {
  if (sourceRevisionId) {
    const { getRevisionById } = await import("./revisionDb");
    const rev = await getRevisionById(sourceRevisionId);
    return rev?.resultImageUrl ?? null;
  }
  const imageUrl = concept[`imageUrl${variationKey}` as "imageUrlA" | "imageUrlB" | "imageUrlC"];
  const productionUrl = concept[`productionUrl${variationKey}` as "productionUrlA" | "productionUrlB" | "productionUrlC"];
  return imageUrl ?? productionUrl ?? null;
}

function slugify(s: string): string {
  return (s || "design").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "design";
}

async function fetchToBuffer(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download design source: ${url} (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

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
        /** MANUAL color selection (PO 2026-06-17): specific template ids to use instead of the
         *  auto color-matcher. When provided, ONLY these templates are composited (the seller picked
         *  the shirt colors themselves). Empty/omitted = auto-pick via colorCount/pickBestColors. */
        templateIds: z.array(z.string()).optional(),
        /** Force re-derive the production (transparent) URL, ignoring the cached value (PO 2026-06-17).
         *  Use this to invalidate concepts whose cached productionUrl* was created by the broken v2
         *  gpt-image-2 generate-mode path (PADDLE WHISPERER class — the cached URL is a model-redrawn
         *  llama, not the actual design). Default false = keep current cache-first behavior. */
        regenerateProduction: z.boolean().optional().default(false),
        /** Generate mockups for a SPECIFIC design version, not the live slot (PO 2026-06-17,
         *  per-design identity). When set, designUrl is resolved from that revision's resultImageUrl
         *  and the production URL is derived fresh (no live-slot caching for historical versions).
         *  Each rendered mockup row stores this id so multiple versions' mockups coexist. */
        sourceRevisionId: z.string().min(1).optional(),
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
      // PER-DESIGN PATH (PO 2026-06-17, per-design identity): when sourceRevisionId is set, the
      // source is THAT revision's resultImageUrl — not the concept's live imageUrlA. Production URL
      // is derived fresh (rembg is $0.001, no per-revision cache needed). The cached productionUrlA
      // on the concept is for the LIVE slot only and is untouched here.
      let designUrl: string | null | undefined = undefined;
      let isProductionReady = false;
      if (input.sourceRevisionId) {
        // PO 2026-06-17 — V5-overwrite fix: DO NOT call processDesignForProduction here. That
        // function writes to concept.productionUrlA (the LIVE slot cache), which was silently
        // overwriting the live design's cutout every time the user clicked Make-mockup on a
        // historical version (PO: "OVERWROTE 'Stuck at 3.5 V5' to create a brand new image of
        // what was generated"). For per-revision mockups, the revision's resultImageUrl IS the
        // design (v5 pass-through means no bg-removal anyway), so we skip the processor entirely
        // and feed the URL straight to the compositor. Zero side effects on the live slot.
        const { getRevisionById } = await import("./revisionDb");
        const rev = await getRevisionById(input.sourceRevisionId);
        if (!rev) throw new TRPCError({ code: "NOT_FOUND", message: `Revision ${input.sourceRevisionId} not found` });
        console.log(`[Mockup] Per-revision generate (rev=${input.sourceRevisionId}) — using revision URL as-is`);
        designUrl = rev.resultImageUrl;
        isProductionReady = false; // not a production-cropped URL — compositor handles content placement
      } else {
        // LIVE SLOT PATH (existing behavior): regenerateProduction forces the auto-process path
        // even when a cached productionUrl exists — the escape hatch for invalidating cached URLs
        // poisoned by the v2 gpt-image-2 redraw bug.
        designUrl = isManual || input.regenerateProduction ? null : concept[productionUrlKey];
        isProductionReady = !!designUrl;
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

      // 3. Color selection: MANUAL (specific templateIds the seller picked) wins over AUTO (the
      // contrast matcher). PO 2026-06-17: "can I select what mockup colors to use and not AUTO mode?"
      if (input.templateIds && input.templateIds.length > 0) {
        const wanted = new Set(input.templateIds);
        const picked = templates.filter((t) => wanted.has(t.id));
        if (picked.length > 0) templates = picked; // ignore unknown ids; never end up with zero
      } else if (input.colorCount && input.colorCount < templates.length) {
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
      // PER-DESIGN SCOPE (PO 2026-06-17): when sourceRevisionId is set, only the OLD renders for
      // THAT specific version are replaced — other versions' mockups stay (no cross-deletion). For
      // the live slot, only NULL-sourceRevisionId renders are touched, so a re-generate on the live
      // slot never wipes historical-version renders that were generated separately.
      const allPriorRenders = await getMockupsByConceptVariation(input.conceptId, input.variationKey);
      const priorRenders = allPriorRenders.filter((r) =>
        input.sourceRevisionId
          ? r.sourceRevisionId === input.sourceRevisionId
          : r.sourceRevisionId === null
      );

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

          // Save to DB — PER-DESIGN: tie the render to its source revision (NULL = live slot).
          const render = await createMockupRender({
            conceptId: input.conceptId,
            variationKey: input.variationKey,
            templateId: template.id,
            compositeUrl: url,
            sourceRevisionId: input.sourceRevisionId ?? null,
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

  /** Readability score per render for the Listings UI (PO 2026-06-17). The matcher's signal stopped
   *  at generation time, so a dark-gray "Kitchen Violation" design shipped on a near-invisible Espresso
   *  shirt because the manual checkbox grid had no contrast hint. This exposes the same per-template
   *  worstSig score (level "low" when worstSig < 0.25) so Manus can paint low-contrast tiles with a
   *  red border + show a warning banner. PO chose WARN (don't block) — publish path is unchanged. */
  getReadability: protectedProcedure
    .input(z.object({ conceptId: z.number(), variationKey: z.enum(["A", "B", "C"]).optional() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return [];
      const concepts = await db.select().from(designConcepts).where(eq(designConcepts.id, input.conceptId)).limit(1);
      const concept = concepts[0];
      if (!concept) throw new TRPCError({ code: "NOT_FOUND", message: "Concept not found" });
      const designUrl = concept.productionUrlA || concept.imageUrlA;
      if (!designUrl) return [];
      const renders = input.variationKey
        ? await getMockupsByConceptVariation(input.conceptId, input.variationKey)
        : await getMockupsByConcept(input.conceptId);
      if (!renders.length) return [];
      const uniqueTemplateIds = Array.from(new Set(renders.map((r) => r.templateId)));
      const templates = await getMockupTemplatesByIds(uniqueTemplateIds);
      const templatesById = new Map(templates.map((t) => [t.id, t]));
      return scoreRendersReadability(designUrl, renders.map((r) => ({ id: r.id, templateId: r.templateId })), templatesById);
    }),

  /** Print export — full continuous-tone design at 300 DPI, transparent PNG (PO 2026-06-17, feat B).
   *  This is the file a DTF/DTG press actually prints; garment-independent. Operates on the selected
   *  version (sourceRevisionId) or the live design. */
  exportPrintFile: protectedProcedure
    .input(z.object({
      conceptId: z.number(),
      variationKey: z.enum(["A", "B", "C"]).default("A"),
      sourceRevisionId: z.string().min(1).optional(),
      widthIn: z.number().min(1).max(40).default(12),
      heightIn: z.number().min(1).max(40).default(16),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const concept = (await db.select().from(designConcepts).where(eq(designConcepts.id, input.conceptId)).limit(1))[0];
      if (!concept) throw new TRPCError({ code: "NOT_FOUND", message: "Concept not found" });
      const srcUrl = await resolveExportSourceUrl(concept, input.variationKey, input.sourceRevisionId);
      if (!srcUrl) throw new TRPCError({ code: "BAD_REQUEST", message: "No design image to export" });

      const srcBuf = await fetchToBuffer(srcUrl);
      const png = await prepareFullTonePrintFile(srcBuf, input.widthIn, input.heightIn);
      const stored = await persistPrintFile(png, {
        conceptId: input.conceptId, variationKey: input.variationKey, sourceRevisionId: input.sourceRevisionId,
        kind: "fulltone", filename: `${slugify(concept.conceptName)}-print.png`,
        widthPx: input.widthIn * 300, heightPx: input.heightIn * 300,
      });
      return { ...stored };
    }),

  /** Halftone print export (PO 2026-06-17, feat B). One single-ink AM halftone separation per
   *  requested ink (black first/default), 300 DPI transparent PNG, for screen-print or the halftone
   *  look. Inks processed SEQUENTIALLY (each 300-DPI raw buffer is ~69MB; Coolify OOM history). */
  generateHalftone: protectedProcedure
    .input(z.object({
      conceptId: z.number(),
      variationKey: z.enum(["A", "B", "C"]).default("A"),
      sourceRevisionId: z.string().min(1).optional(),
      inkColors: z.array(z.enum(INK_NAMES)).min(1).max(7).default(["black"]),
      lpi: z.number().min(20).max(85).default(45),
      widthIn: z.number().min(1).max(40).default(12),
      heightIn: z.number().min(1).max(40).default(16),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const concept = (await db.select().from(designConcepts).where(eq(designConcepts.id, input.conceptId)).limit(1))[0];
      if (!concept) throw new TRPCError({ code: "NOT_FOUND", message: "Concept not found" });
      const srcUrl = await resolveExportSourceUrl(concept, input.variationKey, input.sourceRevisionId);
      if (!srcUrl) throw new TRPCError({ code: "BAD_REQUEST", message: "No design image to halftone" });

      const srcBuf = await fetchToBuffer(srcUrl);
      const slug = slugify(concept.conceptName);
      // De-dup inks (preserve order, black first if present) and process sequentially for memory.
      const inks = Array.from(new Set(input.inkColors)) as InkName[];
      const results: Array<{ inkColor: InkName; url: string; filename: string }> = [];
      for (const inkColor of inks) {
        const png = await generateHalftoneSeparation(srcBuf, {
          inkColor, lpi: input.lpi, widthIn: input.widthIn, heightIn: input.heightIn,
        });
        const stored = await persistPrintFile(png, {
          conceptId: input.conceptId, variationKey: input.variationKey, sourceRevisionId: input.sourceRevisionId,
          kind: "halftone", inkColor, filename: `${slug}-halftone-${inkColor}.png`,
          widthPx: input.widthIn * 300, heightPx: input.heightIn * 300,
        });
        results.push({ inkColor, url: stored.url, filename: stored.filename });
      }
      return { results, lpi: input.lpi, dpi: 300, note: "Single-ink halftone proof — verify on a test print before relying on it." };
    }),

  /** Color knockout print file (PO 2026-06-17, CP2): delete a color (usually the shirt color) so the
   *  garment shows through — e.g. a white-line skull on black → knock out black. Flood mode (default)
   *  removes only the border-connected background, preserving the design's own same-color detail.
   *  Returns the transparent print PNG + a flattened-on-garment PREVIEW so the seller SEES the garment
   *  through the holes before printing (mandatory per the print-shop review). */
  knockoutPrintFile: protectedProcedure
    .input(z.object({
      conceptId: z.number(),
      variationKey: z.enum(["A", "B", "C"]).default("A"),
      sourceRevisionId: z.string().min(1).optional(),
      knockoutColor: z.string(),                 // hex of the color to delete (usually the shirt color)
      garmentColor: z.string().optional(),       // hex for the preview swatch; defaults to knockoutColor
      tolerance: z.number().min(10).max(150).default(60),
      fuzz: z.number().min(0).max(120).default(45),
      mode: z.enum(["flood", "global"]).default("flood"),
      widthIn: z.number().min(1).max(40).default(12),
      heightIn: z.number().min(1).max(40).default(16),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const concept = (await db.select().from(designConcepts).where(eq(designConcepts.id, input.conceptId)).limit(1))[0];
      if (!concept) throw new TRPCError({ code: "NOT_FOUND", message: "Concept not found" });
      const target = hexToRgb(input.knockoutColor);
      if (!target) throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid knockoutColor hex" });
      const srcUrl = await resolveExportSourceUrl(concept, input.variationKey, input.sourceRevisionId);
      if (!srcUrl) throw new TRPCError({ code: "BAD_REQUEST", message: "No design image to knock out" });

      const srcBuf = await fetchToBuffer(srcUrl);
      const knocked = await knockoutColors(srcBuf, {
        targets: [target], tolerance: input.tolerance, fuzz: input.fuzz, mode: input.mode,
      });

      // Print file: size the knocked-out design to print resolution + persist.
      const printPng = await prepareFullTonePrintFile(knocked, input.widthIn, input.heightIn);
      const stored = await persistPrintFile(printPng, {
        conceptId: input.conceptId, variationKey: input.variationKey, sourceRevisionId: input.sourceRevisionId,
        kind: "knockout", inkColor: input.knockoutColor,
        filename: `${slugify(concept.conceptName)}-knockout.png`,
        widthPx: input.widthIn * 300, heightPx: input.heightIn * 300,
      });

      // PREVIEW (mandatory): flatten the knocked-out design over the garment color so the seller sees
      // the shirt showing through the holes. Small, not persisted — it's a proof, not a deliverable.
      const swatch = hexToRgb(input.garmentColor ?? input.knockoutColor) ?? { r: 17, g: 17, b: 17 };
      const previewBuf = await (await import("sharp")).default(knocked)
        .resize(700, 700, { fit: "inside", withoutEnlargement: false })
        .flatten({ background: swatch })
        .webp()
        .toBuffer();
      const { url: previewUrl } = await storagePut(
        `print-preview/${input.conceptId}-${input.variationKey}-${nanoid(6)}-knockout-preview.webp`, previewBuf, "image/webp",
      );

      return { ...stored, previewUrl };
    }),

  /** Design-type recommendation (PO 2026-06-17, CP3). Classifies the design so the UI can RECOMMEND
   *  the right print treatment — and warn (NOT grey-out) before someone one-click-halftones a
   *  photoreal design into a black blob. Returns type + per-tool fit + a plain-English reason. */
  classifyDesign: protectedProcedure
    .input(z.object({
      conceptId: z.number(),
      variationKey: z.enum(["A", "B", "C"]).default("A"),
      sourceRevisionId: z.string().min(1).optional(),
    }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const concept = (await db.select().from(designConcepts).where(eq(designConcepts.id, input.conceptId)).limit(1))[0];
      if (!concept) throw new TRPCError({ code: "NOT_FOUND", message: "Concept not found" });
      const srcUrl = await resolveExportSourceUrl(concept, input.variationKey, input.sourceRevisionId);
      if (!srcUrl) throw new TRPCError({ code: "BAD_REQUEST", message: "No design image to classify" });
      const srcBuf = await fetchToBuffer(srcUrl);
      return classifyDesignType(srcBuf);
    }),

  /** Garment-fit guidance (PO 2026-06-17, CP4). Recommends shirt-color DIRECTION from the design's
   *  light/dark content (the contrast matcher under-surfaces black for light-content vintage designs)
   *  + the DTF white-underbase reminder for dark shirts. Advisory — does not change auto color picks. */
  getGarmentGuidance: protectedProcedure
    .input(z.object({
      conceptId: z.number(),
      variationKey: z.enum(["A", "B", "C"]).default("A"),
      sourceRevisionId: z.string().min(1).optional(),
    }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const concept = (await db.select().from(designConcepts).where(eq(designConcepts.id, input.conceptId)).limit(1))[0];
      if (!concept) throw new TRPCError({ code: "NOT_FOUND", message: "Concept not found" });
      const srcUrl = await resolveExportSourceUrl(concept, input.variationKey, input.sourceRevisionId);
      if (!srcUrl) throw new TRPCError({ code: "BAD_REQUEST", message: "No design image to analyze" });
      const srcBuf = await fetchToBuffer(srcUrl);
      return analyzeGarmentFit(srcBuf);
    }),

  /** Print-files library (PO 2026-06-17): every generated print export for a concept, newest first.
   *  Fixes "where are the stored downloadable print files?" — they're now persisted + retrievable. */
  getPrintFiles: protectedProcedure
    .input(z.object({ conceptId: z.number() }))
    .query(async ({ input }) => {
      return getPrintFilesByConcept(input.conceptId);
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

  /** Bulk-delete mockups (PO 2026-06-17: "can I bulk delete mockups?"). Pass the ids to remove, or
   *  set allForConcept to clear every render for a concept (+ optional variation). */
  deleteMockups: protectedProcedure
    .input(z.object({
      mockupIds: z.array(z.string()).optional(),
      conceptId: z.number().optional(),
      variationKey: z.enum(["A", "B", "C"]).optional(),
    }))
    .mutation(async ({ input }) => {
      let ids = input.mockupIds ?? [];
      if (input.conceptId) {
        const renders = input.variationKey
          ? await getMockupsByConceptVariation(input.conceptId, input.variationKey)
          : await getMockupsByConcept(input.conceptId);
        ids = Array.from(new Set([...ids, ...renders.map((r) => r.id)]));
      }
      for (const id of ids) await deleteMockupRender(id);
      return { success: true, deleted: ids.length };
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
