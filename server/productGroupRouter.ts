/**
 * Product Group Router — Phase C
 * Procedures: list, get, create, update, addMockup, updateMockup, deleteMockup, uploadMockupImage
 * Karpathy: only what's needed. No speculative CRUD.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, protectedProcedure } from "./_core/trpc";
import {
  getProductGroupsByWorkspace,
  getProductGroupById,
  createProductGroup,
  updateProductGroup,
  getMockupsByGroup,
  createMockupTemplate,
  updateMockupTemplate,
  deleteMockupTemplate,
} from "./productGroupDb";
import { storagePut } from "./storage";

const pricingTierSchema = z.object({
  sizes: z.array(z.string()),
  price: z.number().positive(),
});

export const productGroupRouter = router({
  /** List all product groups for a workspace */
  list: protectedProcedure
    .input(z.object({ workspaceId: z.string() }))
    .query(async ({ input }) => {
      return getProductGroupsByWorkspace(input.workspaceId);
    }),

  /** Get a single product group with its mockup templates */
  get: protectedProcedure
    .input(z.object({ groupId: z.string() }))
    .query(async ({ input }) => {
      const group = await getProductGroupById(input.groupId);
      if (!group) throw new TRPCError({ code: "NOT_FOUND", message: "Product group not found" });
      const mockups = await getMockupsByGroup(input.groupId);
      return { ...group, mockups };
    }),

  /** Create a new product group */
  create: protectedProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        name: z.string().min(1).max(255),
        slug: z.string().min(1).max(100).regex(/^[a-z0-9-]+$/),
        description: z.string().optional(),
        productType: z.string().max(100).optional(),
        compareAtPrice: z.number().positive().optional(),
        pricingTiers: z.array(pricingTierSchema).optional(),
        printZone: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).optional(),
      })
    )
    .mutation(async ({ input }) => {
      return createProductGroup({
        workspaceId: input.workspaceId,
        name: input.name,
        slug: input.slug,
        description: input.description ?? null,
        productType: input.productType ?? "T-Shirt",
        compareAtPrice: input.compareAtPrice ? String(input.compareAtPrice) : null,
        pricingTiers: input.pricingTiers ?? null,
        printZone: input.printZone ?? null,
      });
    }),

  /** Update group metadata or pricing tiers.
   * When printZone is provided with referenceTemplateId, the zone is converted
   * from photo-relative to garment-relative coordinates for portability across templates.
   */
  update: protectedProcedure
    .input(
      z.object({
        groupId: z.string(),
        name: z.string().min(1).max(255).optional(),
        description: z.string().optional(),
        productType: z.string().max(100).optional(),
        compareAtPrice: z.number().positive().optional(),
        pricingTiers: z.array(pricingTierSchema).optional(),
        printZone: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).optional(),
        /** Template ID whose photo was used to draw the print zone.
         * Required when printZone is provided — used to convert photo-relative → garment-relative. */
        referenceTemplateId: z.string().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const { groupId, referenceTemplateId, ...data } = input;
      // 2026-06-08 FOUNDATIONAL CHANGE: print zones are stored PHOTO-relative — the exact
      // rectangle the human drew on the template (POD standard). The old photo→garment
      // conversion (via the vision-LLM garment box) was removed; that box was unreliable
      // (LLMs locate boxes poorly) and made placement off-center/off-location. Store as drawn.
      void referenceTemplateId; // accepted for backward-compat but no longer used
      const printZoneToStore = data.printZone;

      await updateProductGroup(groupId, {
        ...(data.name && { name: data.name }),
        ...(data.description !== undefined && { description: data.description }),
        ...(data.productType !== undefined && { productType: data.productType }),
        ...(data.compareAtPrice !== undefined && { compareAtPrice: String(data.compareAtPrice) }),
        ...(data.pricingTiers !== undefined && { pricingTiers: data.pricingTiers }),
        ...(printZoneToStore !== undefined && { printZone: printZoneToStore }),
      });
      return { ok: true };
    }),

  /**
   * Upload a mockup image to S3 and create a mockup_template row.
   * Frontend sends the image as a base64 string with mime type.
   */
  uploadMockup: protectedProcedure
    .input(
      z.object({
        groupId: z.string(),
        colorName: z.string().min(1).max(100),
        colorHex: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
        availableSizes: z.array(z.string()).min(1),
        sortOrder: z.number().int().min(0).default(0),
        /** base64-encoded image data */
        imageBase64: z.string(),
        mimeType: z.enum(["image/jpeg", "image/png", "image/webp"]),
      })
    )
    .mutation(async ({ input }) => {
      // Decode base64 to buffer
      const buffer = Buffer.from(input.imageBase64, "base64");
      const ext = input.mimeType === "image/jpeg" ? "jpg" : input.mimeType === "image/png" ? "png" : "webp";
      const relKey = `mockups/${input.groupId}/${input.colorName.toLowerCase().replace(/\s+/g, "-")}.${ext}`;

      const { key, url } = await storagePut(relKey, buffer, input.mimeType);

      const mockup = await createMockupTemplate({
        groupId: input.groupId,
        colorName: input.colorName,
        colorHex: input.colorHex,
        imageUrl: url,
        imageKey: key,
        availableSizes: input.availableSizes,
        sortOrder: input.sortOrder,
      });

      return mockup;
    }),

  /** Update color name, hex, or available sizes on an existing mockup */
  updateMockup: protectedProcedure
    .input(
      z.object({
        mockupId: z.string(),
        colorName: z.string().min(1).max(100).optional(),
        colorHex: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
        availableSizes: z.array(z.string()).min(1).optional(),
        sortOrder: z.number().int().min(0).optional(),
      })
    )
    .mutation(async ({ input }) => {
      const { mockupId, ...data } = input;
      await updateMockupTemplate(mockupId, data);
      return { ok: true };
    }),

  /** Delete a mockup template (does not delete the S3 file) */
  deleteMockup: protectedProcedure
    .input(z.object({ mockupId: z.string() }))
    .mutation(async ({ input }) => {
      await deleteMockupTemplate(input.mockupId);
      return { ok: true };
    }),
});
