/**
 * Revision Router — Phase G
 * Procedures: getReviewQueue, submitRevision, acceptDesign, getHistory, revertToOriginal
 * Karpathy: only what's needed, no speculative endpoints.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, protectedProcedure } from "./_core/trpc";
import { generateRevision, generateRevisionViaFalKontext, trimAndCleanRevision } from "./revisionEngine";
import {
  getRevisionsByConceptVariation,
  getRevisionById,
  markRevisionAccepted,
  deleteRevisionsByConceptVariation,
} from "./revisionDb";
import { getConceptById, getConceptsByRunId, updateConceptProductionUrl, updateConceptImages } from "./db";
import { getTrendPatternsByIds } from "./nicheHunterDb";

/**
 * Self-healing backfill (PO 2026-06-10). Older niche-pattern concepts were created with
 * imageUrlA = previewImageUrl — the on-shirt MOCKUP (compositor(productionDesignUrl + template)).
 * The Design Studio REVISES imageUrlA, so it must be the canonical CLEAN design
 * (productionDesignUrl), never the shirt photo. On read, flip any concept STILL pointing at the
 * exact mockup URL to the clean design and persist it. Safety:
 *   - only flips when imageUrlA === the linked pattern's previewImageUrl, so a user's accepted
 *     REVISION (a different URL) is never touched;
 *   - idempotent — once flipped, imageUrlA === productionDesignUrl (!== previewImageUrl), so it
 *     won't re-fire;
 *   - new concepts are already correct (createConceptFromPattern, ca928b7) — this only heals the
 *     ones approved before that fix.
 */
async function healNicheConceptDesignUrls<
  T extends { id: number; nichePatternId: string | null; imageUrlA: string | null }
>(concepts: T[]): Promise<T[]> {
  const patternIds = Array.from(
    new Set(concepts.map((c) => c.nichePatternId).filter((x): x is string => !!x))
  );
  if (patternIds.length === 0) return concepts;
  const byId = new Map((await getTrendPatternsByIds(patternIds)).map((p) => [p.id, p]));
  for (const c of concepts) {
    if (!c.nichePatternId) continue;
    const p = byId.get(c.nichePatternId);
    if (
      p?.productionDesignUrl &&
      c.imageUrlA === p.previewImageUrl &&
      c.imageUrlA !== p.productionDesignUrl
    ) {
      await updateConceptImages(c.id, { imageUrlA: p.productionDesignUrl });
      c.imageUrlA = p.productionDesignUrl; // patch in-memory for this response
    }
  }
  return concepts;
}

export const revisionRouter = router({
  /**
   * Get winning concepts that have images — the review queue.
   * Returns concepts with at least one image URL, grouped by run.
   */
  getReviewQueue: protectedProcedure
    .input(z.object({ runId: z.number() }))
    .query(async ({ input }) => {
      const concepts = await healNicheConceptDesignUrls(await getConceptsByRunId(input.runId));
      // Only return concepts that have at least one generated image
      return concepts.filter(
        (c) => c.imageUrlA || c.imageUrlB || c.imageUrlC
      );
    }),

  /**
   * Get a single concept by ID — used by Design Studio when ?conceptId= is in URL.
   */
  getConcept: protectedProcedure
    .input(z.object({ conceptId: z.number() }))
    .query(async ({ input }) => {
      const concept = await getConceptById(input.conceptId);
      if (!concept) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Concept not found" });
      }
      const [healed] = await healNicheConceptDesignUrls([concept]);
      return healed;
    }),

  /**
   * Submit a revision instruction — generates a new image using GPT Image
   * with the current image as reference.
   */
  submitRevision: protectedProcedure
    .input(
      z.object({
        conceptId: z.number(),
        variationKey: z.enum(["A", "B", "C"]),
        instruction: z.string().min(1).max(2000),
        /** Output canvas aspect (PO 2026-06-16): default "1:1" keeps the original surgical-edit
         *  behavior (anti-outpaint guardrail). Portrait/landscape options unlock canvas-changing
         *  edits like "extend vertically" by using gpt-image-1's native non-square sizes. */
        aspectRatio: z.enum(["1:1", "3:4", "4:3", "9:16", "16:9"]).optional().default("1:1"),
        /** Which image engine to use (PO 2026-06-17, photo-editor pivot):
         *   - "gpt-image" (default) — the existing gpt-image-1 surgical/redesign path. Best at
         *     simple text edits, "change YEE DINK to YEE HAW", small style tweaks.
         *   - "fal-kontext" — FLUX.1 Kontext via fal. Built for "swap subject, freeze the rest"
         *     and "redraw in a new style" — the cases where ChatGPT's editor used to beat us. */
        engine: z.enum(["gpt-image", "fal-kontext"]).optional().default("gpt-image"),
      })
    )
    .mutation(async ({ input }) => {
      const concept = await getConceptById(input.conceptId);
      if (!concept) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Concept not found" });
      }

      // Determine the current image URL for this variation
      const imageUrlMap: Record<string, string | null> = {
        A: concept.imageUrlA,
        B: concept.imageUrlB,
        C: concept.imageUrlC,
      };
      const referenceImageUrl = imageUrlMap[input.variationKey];
      if (!referenceImageUrl) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `No image exists for variation ${input.variationKey}`,
        });
      }

      // CHAIN-ANCHOR (PO 2026-06-16): chain only off ACCEPTED revisions. Anything unaccepted is a
      // discarded experiment — the next submit goes back to the canonical original (imageUrlA). This
      // matches the user's mental model: "if I don't Accept, it doesn't count" — and stops the drift
      // cascade where one bad output poisons every subsequent edit. Pre-aspect-picker, this code
      // chained off the latest revision regardless of accepted state.
      const existingRevisions = await getRevisionsByConceptVariation(
        input.conceptId,
        input.variationKey
      );
      const acceptedRevision = existingRevisions.find((r) => r.accepted);
      const actualReference = acceptedRevision
        ? acceptedRevision.resultImageUrl
        : referenceImageUrl;

      const result = input.engine === "fal-kontext"
        ? await generateRevisionViaFalKontext(
            input.conceptId,
            input.variationKey,
            input.instruction,
            actualReference,
            input.aspectRatio,
          )
        : await generateRevision(
            input.conceptId,
            input.variationKey,
            input.instruction,
            actualReference,
            {
              conceptName: concept.conceptName,
              format: concept.format,
              style: concept.style,
              headline: concept.headline,
              subtext: concept.subtext,
            },
            input.aspectRatio
          );

      return { revisionId: result.revisionId, imageUrl: result.imageUrl };
    }),

  /**
   * Deterministic "Clean & Trim" — remove faint text (e.g. the disclaimer under the design) and
   * trim to content, with NO AI regeneration so everything else stays pixel-identical. Resolves
   * the current image the same way submitRevision does (latest revision, else the original).
   */
  trimAndClean: protectedProcedure
    .input(
      z.object({
        conceptId: z.number(),
        variationKey: z.enum(["A", "B", "C"]),
      })
    )
    .mutation(async ({ input }) => {
      const concept = await getConceptById(input.conceptId);
      if (!concept) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Concept not found" });
      }
      const imageUrlMap: Record<string, string | null> = {
        A: concept.imageUrlA,
        B: concept.imageUrlB,
        C: concept.imageUrlC,
      };
      const referenceImageUrl = imageUrlMap[input.variationKey];
      if (!referenceImageUrl) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `No image exists for variation ${input.variationKey}`,
        });
      }
      // CHAIN-ANCHOR (PO 2026-06-16): same accepted-only rule as submitRevision above.
      const existingRevisions = await getRevisionsByConceptVariation(
        input.conceptId,
        input.variationKey
      );
      const acceptedRevision = existingRevisions.find((r) => r.accepted);
      const actualReference = acceptedRevision
        ? acceptedRevision.resultImageUrl
        : referenceImageUrl;

      const result = await trimAndCleanRevision(
        input.conceptId,
        input.variationKey,
        actualReference
      );
      return { revisionId: result.revisionId, imageUrl: result.imageUrl };
    }),

  /**
   * Remove background — USER-DRIVEN transparent cutout (PO 2026-06-17 QA 1.5). Uses fal rembg to
   * produce REAL alpha transparency (the Kontext "remove background" instruction returned opaque
   * images, so the bg never went away). Creates a new revision; the original is snapshotted + kept.
   */
  removeBackground: protectedProcedure
    .input(
      z.object({
        conceptId: z.number(),
        variationKey: z.enum(["A", "B", "C"]),
      })
    )
    .mutation(async ({ input }) => {
      const concept = await getConceptById(input.conceptId);
      if (!concept) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Concept not found" });
      }
      const imageUrlMap: Record<string, string | null> = {
        A: concept.imageUrlA,
        B: concept.imageUrlB,
        C: concept.imageUrlC,
      };
      const referenceImageUrl = imageUrlMap[input.variationKey];
      if (!referenceImageUrl) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `No image exists for variation ${input.variationKey}` });
      }
      // Same accepted-only chain anchor as the other revision actions.
      const existingRevisions = await getRevisionsByConceptVariation(input.conceptId, input.variationKey);
      const acceptedRevision = existingRevisions.find((r) => r.accepted);
      const actualReference = acceptedRevision ? acceptedRevision.resultImageUrl : referenceImageUrl;

      const { removeBackgroundRevision } = await import("./revisionEngine");
      const result = await removeBackgroundRevision(input.conceptId, input.variationKey, actualReference);
      return { revisionId: result.revisionId, imageUrl: result.imageUrl };
    }),

  /**
   * Blend background into garment — luminance-keyed opacity (PO 2026-06-17). For full-SCENE designs
   * (the raccoon) where removal can't cut cleanly: fade dark/desaturated areas to transparent so the
   * scene melts into a dark shirt; light subject + colourful elements stay. New revision; original kept.
   */
  blendBackground: protectedProcedure
    .input(
      z.object({
        conceptId: z.number(),
        variationKey: z.enum(["A", "B", "C"]),
      })
    )
    .mutation(async ({ input }) => {
      const concept = await getConceptById(input.conceptId);
      if (!concept) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Concept not found" });
      }
      const imageUrlMap: Record<string, string | null> = {
        A: concept.imageUrlA,
        B: concept.imageUrlB,
        C: concept.imageUrlC,
      };
      const referenceImageUrl = imageUrlMap[input.variationKey];
      if (!referenceImageUrl) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `No image exists for variation ${input.variationKey}` });
      }
      const existingRevisions = await getRevisionsByConceptVariation(input.conceptId, input.variationKey);
      const acceptedRevision = existingRevisions.find((r) => r.accepted);
      const actualReference = acceptedRevision ? acceptedRevision.resultImageUrl : referenceImageUrl;

      const { reduceBackgroundOpacityRevision } = await import("./revisionEngine");
      const result = await reduceBackgroundOpacityRevision(input.conceptId, input.variationKey, actualReference);
      return { revisionId: result.revisionId, imageUrl: result.imageUrl };
    }),

  /**
   * Accept a specific revision (or the original) as the final design.
   * Marks the revision as accepted and un-accepts all others.
   */
  acceptDesign: protectedProcedure
    .input(
      z.object({
        revisionId: z.string(),
      })
    )
    .mutation(async ({ input }) => {
      const rev = await getRevisionById(input.revisionId);
      if (!rev) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Revision not found" });
      }
      await markRevisionAccepted(input.revisionId);

      // WIRE TO DOWNSTREAM: the accepted revision IS the design now. Write it into the concept's
      // productionUrl<variation> — the field the mockup generator AND color matcher actually read
      // (productionUrlX || imageUrlX). Without this, Accept only flips a flag in the revisions
      // table and the Mockups page keeps compositing the OLD image. Revision images are already
      // background-stripped/transparent, so they're production-ready as-is.
      await updateConceptProductionUrl(
        rev.conceptId,
        rev.variationKey as "A" | "B" | "C",
        rev.resultImageUrl
      );
      return { success: true };
    }),

  /**
   * Get revision history for a concept+variation, newest first.
   */
  getHistory: protectedProcedure
    .input(
      z.object({
        conceptId: z.number(),
        variationKey: z.enum(["A", "B", "C"]),
      })
    )
    .query(async ({ input }) => {
      return getRevisionsByConceptVariation(input.conceptId, input.variationKey);
    }),

  /**
   * Revert to original — delete all revisions for a concept+variation.
   */
  revertToOriginal: protectedProcedure
    .input(
      z.object({
        conceptId: z.number(),
        variationKey: z.enum(["A", "B", "C"]),
      })
    )
    .mutation(async ({ input }) => {
      await deleteRevisionsByConceptVariation(input.conceptId, input.variationKey);
      // Clear the production override so downstream falls back to the ORIGINAL: with
      // productionUrl<variation> = null, mockup.generate re-derives it from the original
      // imageUrl<variation> (auto-process). Otherwise it would keep serving the now-deleted
      // accepted revision's image.
      await updateConceptProductionUrl(input.conceptId, input.variationKey, null);
      return { success: true };
    }),

  /**
   * Delete a concept entirely from the Design Studio queue.
   * Removes the concept row and all associated revisions.
   */
  deleteConcept: protectedProcedure
    .input(z.object({ conceptId: z.number() }))
    .mutation(async ({ input }) => {
      const { deleteConceptById } = await import("./db");
      await deleteConceptById(input.conceptId);
      return { success: true };
    }),

  /** Fetch a single revision by id — used by Mockups to resolve the version name
   *  regardless of whether it lives under variationKey A/B/C or the HISTORY_KEY H. */
  getOne: protectedProcedure
    .input(z.object({ revisionId: z.string() }))
    .query(async ({ input }) => {
      return getRevisionById(input.revisionId);
    }),
});
