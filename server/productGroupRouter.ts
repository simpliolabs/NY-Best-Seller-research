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
import { DEFAULT_PRINT_AREA } from "./mockupCompositor";

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
        printZone: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number(), widthIn: z.number().optional(), heightIn: z.number().optional() }).optional(),
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
        /** FULL group-level fallback box (+ optional inches) — the explicit "set group default"
         * path. The per-template editor does NOT use this; it sends printZoneInches instead. */
        printZone: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number(), widthIn: z.number().optional(), heightIn: z.number().optional() }).optional(),
        /** INCHES-ONLY update (per-template editor): merge the shared print-area inches into the
         * group's printZone WITHOUT touching x/y/w/h (the per-template boxes live on the mockup
         * rows). Keeps the group box intact while updating the real-world size. */
        printZoneInches: z.object({ widthIn: z.number().positive(), heightIn: z.number().positive() }).optional(),
        referenceTemplateId: z.string().optional(), // accepted+ignored for one deploy (legacy frontend)
      })
    )
    .mutation(async ({ input }) => {
      const { groupId, referenceTemplateId, printZoneInches, ...data } = input;
      void referenceTemplateId; // accepted for backward-compat but no longer used

      // printZone is stored PHOTO-relative. Two write paths:
      //  - printZone (full box): explicit set-group-default (legacy single-zone path).
      //  - printZoneInches: per-template editor — MERGE inches into the existing group box,
      //    preserving x/y/w/h (the per-color boxes are stored on the mockup rows, NOT here).
      let printZoneToStore = data.printZone;
      if (printZoneInches) {
        const current = await getProductGroupById(groupId);
        const box = current?.printZone ?? DEFAULT_PRINT_AREA;
        printZoneToStore = { x: box.x, y: box.y, width: box.width, height: box.height, widthIn: printZoneInches.widthIn, heightIn: printZoneInches.heightIn };
      }

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

  /** Update color name, hex, sizes, OR the per-template PRINT AREA on an existing mockup.
   * printArea = the print rectangle calibrated on THIS color's photo (photo-relative 0-1);
   * stored in the (repurposed) garmentBbox column. This is the per-template calibration path. */
  updateMockup: protectedProcedure
    .input(
      z.object({
        mockupId: z.string(),
        colorName: z.string().min(1).max(100).optional(),
        colorHex: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
        availableSizes: z.array(z.string()).min(1).optional(),
        sortOrder: z.number().int().min(0).optional(),
        printArea: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).optional(),
      })
    )
    .mutation(async ({ input }) => {
      const { mockupId, printArea, ...data } = input;
      // Map the client `printArea` onto the (repurposed) garmentBbox column (no rename).
      await updateMockupTemplate(mockupId, { ...data, ...(printArea !== undefined && { garmentBbox: printArea }) });
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
