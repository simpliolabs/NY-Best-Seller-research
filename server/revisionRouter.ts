/**
 * Revision Router — Phase G
 * Procedures: getReviewQueue, submitRevision, acceptDesign, getHistory, revertToOriginal
 * Karpathy: only what's needed, no speculative endpoints.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, protectedProcedure } from "./_core/trpc";
import { generateRevision, trimAndCleanRevision } from "./revisionEngine";
import {
  getRevisionsByConceptVariation,
  getRevisionById,
  markRevisionAccepted,
  deleteRevisionsByConceptVariation,
} from "./revisionDb";
import { getConceptById, getConceptsByRunId } from "./db";

export const revisionRouter = router({
  /**
   * Get winning concepts that have images — the review queue.
   * Returns concepts with at least one image URL, grouped by run.
   */
  getReviewQueue: protectedProcedure
    .input(z.object({ runId: z.number() }))
    .query(async ({ input }) => {
      const concepts = await getConceptsByRunId(input.runId);
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
      return concept;
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

      // Check if there are existing revisions — use the latest revision's image as reference
      const existingRevisions = await getRevisionsByConceptVariation(
        input.conceptId,
        input.variationKey
      );
      const actualReference =
        existingRevisions.length > 0
          ? existingRevisions[0].resultImageUrl
          : referenceImageUrl;

      const result = await generateRevision(
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
        }
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
      const existingRevisions = await getRevisionsByConceptVariation(
        input.conceptId,
        input.variationKey
      );
      const actualReference =
        existingRevisions.length > 0
          ? existingRevisions[0].resultImageUrl
          : referenceImageUrl;

      const result = await trimAndCleanRevision(
        input.conceptId,
        input.variationKey,
        actualReference
      );
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
});
