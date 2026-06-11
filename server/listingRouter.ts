/**
 * Listing Router — Phase I
 * Procedures: create, list, getById, update, delete, generateDescription
 * Creates Shopify listing drafts from mockups with LLM-generated copy.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, protectedProcedure } from "./_core/trpc";
import { nanoid } from "nanoid";
import {
  createListing,
  getListingsByWorkspace,
  getListingById,
  updateListing,
  deleteListing,
} from "./listingDb";
import { getConceptById } from "./db";
import { getProductGroupById } from "./productGroupDb";
import { invokeLLM } from "./_core/llm";
import { getCredential } from "./workspaceDb";
import { createProduct, addProductImageByUrl, setProductMetafield } from "./shopifyClient";
import { getMockupsByConceptVariation } from "./mockupDb";

/**
 * LLM-generated Shopify SEO meta (global.title_tag / global.description_tag). PO 2026-06-11.
 * Hard-trimmed to SEO lengths in case the model overshoots. Throws on LLM/parse failure — the
 * caller treats meta as best-effort and must never let a failure block the publish.
 */
async function generateSeoMeta(
  title: string,
  description: string
): Promise<{ metaTitle: string; metaDescription: string }> {
  const result = await invokeLLM({
    messages: [
      {
        role: "system",
        content: `You write SEO meta tags for Shopify print-on-demand apparel. Return JSON with "metaTitle" (<=60 characters, compelling, key search terms front-loaded, no surrounding quotes) and "metaDescription" (<=155 characters, ONE line of plain text, no newlines, an enticing click-through summary).`,
      },
      {
        role: "user",
        content: `Product title: ${title}\n\nProduct description:\n${(description || "").slice(0, 800)}`,
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "seo_meta",
        strict: true,
        schema: {
          type: "object",
          properties: {
            metaTitle: { type: "string", description: "<=60 chars SEO meta title" },
            metaDescription: { type: "string", description: "<=155 chars single-line SEO meta description" },
          },
          required: ["metaTitle", "metaDescription"],
          additionalProperties: false,
        },
      },
    },
  });
  const rawContent = result.choices?.[0]?.message?.content ?? "{}";
  const content = typeof rawContent === "string" ? rawContent : JSON.stringify(rawContent);
  const parsed = JSON.parse(content);
  return {
    metaTitle: String(parsed.metaTitle ?? "").slice(0, 70),
    metaDescription: String(parsed.metaDescription ?? "").replace(/\s+/g, " ").trim().slice(0, 160),
  };
}

export const listingRouter = router({
  /**
   * Create a new listing draft from a concept + product group + selected mockups.
   */
  create: protectedProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        conceptId: z.number(),
        productGroupId: z.string(),
        mockupRenderIds: z.array(z.string()).min(1),
        title: z.string().optional(),
        price: z.number().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const concept = await getConceptById(input.conceptId);
      if (!concept) throw new TRPCError({ code: "NOT_FOUND", message: "Concept not found" });

      const group = await getProductGroupById(input.productGroupId);
      if (!group) throw new TRPCError({ code: "NOT_FOUND", message: "Product group not found" });

      // Default price from product group's first pricing tier
      const defaultPrice = group.pricingTiers?.[0]?.price ?? 29.99;
      const compareAtPrice = group.compareAtPrice ? Number(group.compareAtPrice) : undefined;

      // Build default title: "<ConceptName> <ProductType>"
      const productType = group.productType ?? "T-Shirt";
      const defaultTitle = input.title ?? `${concept.conceptName} ${productType}`;

      const id = nanoid();
      await createListing({
        id,
        workspaceId: input.workspaceId,
        conceptId: input.conceptId,
        productGroupId: input.productGroupId,
        title: defaultTitle,
        description: null,
        tags: null,
        price: String(input.price ?? defaultPrice),
        compareAtPrice: compareAtPrice ? String(compareAtPrice) : null,
        mockupRenderIds: input.mockupRenderIds,
        status: "draft",
        shopifyProductId: null,
      });

      return { id };
    }),

  /**
   * List all listings for a workspace, optionally filtered by status.
   */
  list: protectedProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        status: z.enum(["draft", "ready", "exported"]).optional(),
      })
    )
    .query(async ({ input }) => {
      const listings = await getListingsByWorkspace(input.workspaceId, input.status);
      // Build the correct Shopify admin URL per exported listing. The store handle lives in a
      // workspace credential the client doesn't have on the listing, so attach it here — the old
      // client built admin.shopify.com/store/<productId> which is a dead page (PO 2026-06-11).
      const storeDomain = await getCredential(input.workspaceId, "shopify", "storeDomain");
      const handle = storeDomain ? storeDomain.replace(/\.myshopify\.com$/i, "") : null;
      return listings.map((l) => ({
        ...l,
        shopifyAdminUrl: l.shopifyProductId && handle
          ? `https://admin.shopify.com/store/${handle}/products/${l.shopifyProductId}`
          : null,
      }));
    }),

  /**
   * Get a single listing by ID.
   */
  getById: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ input }) => {
      const listing = await getListingById(input.id);
      if (!listing) throw new TRPCError({ code: "NOT_FOUND", message: "Listing not found" });
      return listing;
    }),

  /**
   * Update listing fields (title, description, tags, price, status).
   */
  update: protectedProcedure
    .input(
      z.object({
        id: z.string(),
        title: z.string().optional(),
        description: z.string().optional(),
        tags: z.array(z.string()).optional(),
        price: z.number().optional(),
        compareAtPrice: z.number().nullable().optional(),
        status: z.enum(["draft", "ready", "exported"]).optional(),
        mockupRenderIds: z.array(z.string()).optional(),
      })
    )
    .mutation(async ({ input }) => {
      const { id, ...updates } = input;
      const data: Record<string, unknown> = {};
      if (updates.title !== undefined) data.title = updates.title;
      if (updates.description !== undefined) data.description = updates.description;
      if (updates.tags !== undefined) data.tags = updates.tags;
      if (updates.price !== undefined) data.price = String(updates.price);
      if (updates.compareAtPrice !== undefined) data.compareAtPrice = updates.compareAtPrice ? String(updates.compareAtPrice) : null;
      if (updates.status !== undefined) data.status = updates.status;
      if (updates.mockupRenderIds !== undefined) data.mockupRenderIds = updates.mockupRenderIds;
      await updateListing(id, data as any);
      return { success: true };
    }),

  /**
   * Delete a listing.
   */
  delete: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      await deleteListing(input.id);
      return { success: true };
    }),

  /**
   * Publish a ready listing to Shopify as a draft product.
   * Requires Shopify credentials stored in workspace_credentials.
   * Uploads all mockup images, stores the Shopify product ID, marks listing as exported.
   */
  publishToShopify: protectedProcedure
    .input(z.object({ id: z.string(), workspaceId: z.string() }))
    .mutation(async ({ input }) => {
      const listing = await getListingById(input.id);
      if (!listing) throw new TRPCError({ code: "NOT_FOUND", message: "Listing not found" });
      // Skip-description (PO 2026-06-11): a draft can publish directly without generated copy — the
      // product is created with an empty body_html. Only block re-exporting an already-exported one.
      if (listing.status === "exported") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Listing is already exported to Shopify.",
        });
      }

      // Load Shopify credentials
      const storeDomain = await getCredential(input.workspaceId, "shopify", "storeDomain");
      const accessToken = await getCredential(input.workspaceId, "shopify", "accessToken");
      if (!storeDomain || !accessToken || storeDomain.length < 4 || accessToken.length < 10) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "No Shopify store connected. Go to Workspace Settings to connect your store.",
        });
      }
      const creds = { storeDomain, accessToken };

      const group = listing.productGroupId
        ? await getProductGroupById(listing.productGroupId)
        : null;

      // Build Shopify product payload
      const tagsStr = Array.isArray(listing.tags) ? listing.tags.join(", ") : "";
      const vendor = await getCredential(input.workspaceId, "shopify", "vendor");
      const product = await createProduct(creds, {
        title: listing.title,
        body_html: listing.description ?? "",
        ...(vendor ? { vendor } : {}),
        product_type: (group as any)?.productType ?? "T-Shirt",
        tags: tagsStr,
        status: "draft",
        variants: [
          {
            price: listing.price ?? "29.99",
            ...(listing.compareAtPrice ? { compare_at_price: listing.compareAtPrice } : {}),
          },
        ],
      });

      // Upload mockup images — collect URLs from mockup_renders
      const mockupIds: string[] = Array.isArray(listing.mockupRenderIds)
        ? (listing.mockupRenderIds as string[])
        : [];

      // Fetch composite URLs for the stored mockup render IDs
      // We query all renders for the concept and filter by ID
      const concept = await getConceptById(listing.conceptId);
      const allRenders = concept
        ? await getMockupsByConceptVariation(listing.conceptId, "A")
        : [];
      const allRendersB = concept
        ? await getMockupsByConceptVariation(listing.conceptId, "B")
        : [];
      const allRendersC = concept
        ? await getMockupsByConceptVariation(listing.conceptId, "C")
        : [];
      const allRendersCombined = [...allRenders, ...allRendersB, ...allRendersC];
      const selectedRenders = allRendersCombined.filter((r) => mockupIds.includes(r.id));

      // Upload each mockup image to Shopify (best-effort — don't fail publish if image upload fails)
      for (let i = 0; i < selectedRenders.length; i++) {
        const render = selectedRenders[i]!;
        try {
          await addProductImageByUrl(creds, product.id, render.compositeUrl, i + 1);
        } catch (imgErr) {
          console.warn(`[publishToShopify] Image upload failed for render ${render.id}:`, imgErr);
        }
      }

      // SEO metafields — LLM-generated dedicated meta title/description (PO 2026-06-11).
      // global.title_tag / global.description_tag are Shopify's SEO fields. Best-effort: the
      // product + images already exist, so a meta failure must never block the publish.
      try {
        const meta = await generateSeoMeta(listing.title, listing.description ?? "");
        if (meta.metaTitle) {
          await setProductMetafield(creds, product.id, "global", "title_tag", meta.metaTitle);
        }
        if (meta.metaDescription) {
          await setProductMetafield(creds, product.id, "global", "description_tag", meta.metaDescription);
        }
      } catch (metaErr) {
        console.warn(`[publishToShopify] SEO meta generation/set failed (non-fatal):`, metaErr);
      }

      // Mark listing as exported and store Shopify product ID
      await updateListing(input.id, {
        status: "exported",
        shopifyProductId: String(product.id),
      });

      return {
        shopifyProductId: String(product.id),
        shopifyAdminUrl: `https://${storeDomain}/admin/products/${product.id}`,
      };
    }),

  /**
   * Generate an SEO-optimized Shopify product description + tags using LLM.
   */
  generateDescription: protectedProcedure
    .input(
      z.object({
        conceptId: z.number(),
        title: z.string(),
        productGroupName: z.string(),
        productType: z.string().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const concept = await getConceptById(input.conceptId);
      if (!concept) throw new TRPCError({ code: "NOT_FOUND", message: "Concept not found" });

      const result = await invokeLLM({
        messages: [
          {
            role: "system",
            content: `You are a Shopify product copywriter for print-on-demand apparel. Write compelling, SEO-friendly product descriptions in PLAIN TEXT only — no HTML tags, no markdown, no <p> or <b> tags. Return JSON with "description" (plain text, 2-3 short paragraphs separated by newlines) and "tags" (array of 8-12 relevant Shopify tags for search/SEO).`,
          },
          {
            role: "user",
            content: `Write a Shopify product description for:
Title: ${input.title}
Product type: ${input.productType ?? input.productGroupName}
Design concept: ${concept.conceptName}
Style: ${concept.style}
Headline on design: ${concept.headline ?? "N/A"}
Subtext: ${concept.subtext ?? "N/A"}
Humor/theme: ${concept.humorFramework ?? "N/A"}`,
          },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "listing_copy",
            strict: true,
            schema: {
              type: "object",
              properties: {
                description: { type: "string", description: "Plain text product description, no HTML" },
                tags: { type: "array", items: { type: "string" }, description: "Shopify tags" },
              },
              required: ["description", "tags"],
              additionalProperties: false,
            },
          },
        },
      });

      const rawContent = result.choices?.[0]?.message?.content ?? "{}";
      const content = typeof rawContent === "string" ? rawContent : JSON.stringify(rawContent);
      const parsed = JSON.parse(content);
      return {
        description: parsed.description ?? "",
        tags: Array.isArray(parsed.tags) ? parsed.tags : [],
      };
    }),
});
