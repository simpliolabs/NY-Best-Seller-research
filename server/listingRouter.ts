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
import { getProductGroupById, getMockupsByGroup } from "./productGroupDb";
import { invokeLLM } from "./_core/llm";
import { getCredential } from "./workspaceDb";
import { createProduct, addProductImageByUrl, setProductMetafield, getPrimaryLocationId, setInventoryLevel, setInventoryItemCost, publishProductToChannels, setProductCategory, TSHIRT_CATEGORY_GID, diagnoseInventoryWrites, bulkSetInventory, bulkSetVariantCosts, linkOptionSwatches, setCategoryAttributeMetafields } from "./shopifyClient";
import { getMockupsByConceptVariation } from "./mockupDb";

/** 3-char uppercase abbreviation for SKUs: keep the first letter, then the next consonants
 *  (Espresso → ESP, Dink → DNK). Falls back to the first 3 letters for vowel-heavy names. */
export function abbrev3(name: string): string {
  const clean = (name || "").toUpperCase().replace(/[^A-Z]/g, "");
  if (clean.length <= 3) return clean || "XXX";
  const rest = clean.slice(1).replace(/[AEIOU]/g, "");
  return (clean[0] + (rest.length >= 2 ? rest : clean.slice(1)).slice(0, 2)).slice(0, 3);
}

/** SKU base from the product-group name: alphanumeric, uppercase (e.g. "1717" → "1717"). */
export function skuBase(name: string): string {
  return (name || "PRD").toUpperCase().replace(/[^A-Z0-9]/g, "") || "PRD";
}

/** Tags when a listing has none (Skip Description skips copy+tags) — derived from the concept:
 *  format + signal phrases + the design-name words. PO 2026-06-11. */
function deriveTags(
  concept: { format?: string | null; signalTags?: string[] | null; conceptName?: string | null } | null | undefined,
  fallbackTitle: string,
): string {
  const tags = new Set<string>();
  if (concept?.format) tags.add(concept.format);
  for (const s of concept?.signalTags ?? []) if (s) tags.add(s);
  for (const w of String(concept?.conceptName ?? fallbackTitle).split(/\s+/)) if (w.length > 3) tags.add(w);
  return Array.from(tags).slice(0, 12).join(", ");
}

/**
 * LLM-generated Shopify SEO meta (global.title_tag / global.description_tag). PO 2026-06-11.
 * Hard-trimmed to SEO lengths in case the model overshoots. Throws on LLM/parse failure — the
 * caller treats meta as best-effort and must never let a failure block the publish.
 */
async function generateSeoMeta(
  title: string,
  description: string,
  niche?: string
): Promise<{ metaTitle: string; metaDescription: string }> {
  const result = await invokeLLM({
    messages: [
      {
        role: "system",
        // The niche grounding is load-bearing: with an empty description the model used to pattern-
        // match "Easily Distracted By..." to the famous FISHING tee and invent the wrong niche
        // (PO-caught: "Funny Fishing Tee" on a pickleball shirt). Only the given niche may appear.
        content: `You write SEO meta tags for Shopify print-on-demand apparel. Return JSON with "metaTitle" (<=60 characters, compelling, key search terms front-loaded, no surrounding quotes) and "metaDescription" (<=155 characters, ONE line of plain text, no newlines, an enticing click-through summary). HARD RULE: use ONLY the niche/theme given in the input. NEVER introduce any other hobby, sport, or niche — if the niche keywords say pickleball, the meta is about pickleball, not fishing or anything else.`,
      },
      {
        role: "user",
        content: `Product title: ${title}\n\nNiche / theme keywords (the ONLY allowed topic): ${niche || "infer strictly from the title"}\n\nProduct description:\n${(description || "").slice(0, 800)}`,
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

  /** TEMP diagnostic (PO 2026-06-12): does the live Shopify token have inventory/location access?
   *  Read-only — just lists locations. If this 403s, the reconnect didn't grant the new scopes; if it
   *  returns a location id, the scopes are fine and the inventory WRITE calls are the bug. */
  diagnoseShopify: protectedProcedure
    .input(z.object({ workspaceId: z.string() }))
    .query(async ({ input }) => {
      const storeDomain = await getCredential(input.workspaceId, "shopify", "storeDomain");
      const accessToken = await getCredential(input.workspaceId, "shopify", "accessToken");
      const grantedScope = await getCredential(input.workspaceId, "shopify", "grantedScope");
      const creds = { storeDomain: storeDomain ?? "", accessToken: accessToken ?? "" };
      let locationId: number | null = null;
      let locationError: string | null = null;
      try { locationId = await getPrimaryLocationId(creds); } catch (e: any) { locationError = String(e?.message ?? e).slice(0, 240); }
      const exported = (await getListingsByWorkspace(input.workspaceId, "exported"))[0];
      const writes = exported?.shopifyProductId
        ? await diagnoseInventoryWrites(creds, Number(exported.shopifyProductId))
        : { note: "no exported listing to test" };
      // Category-metafields test (PO 2026-06-12: "rest of metafields did not ship"): run the exact
      // export step against the latest exported product and surface the real warnings. If it works,
      // it also FILLS that product's metafields in place.
      let categoryMetafields: unknown = { note: "no exported listing to test" };
      if (exported?.shopifyProductId && exported.productGroupId) {
        const grp = await getProductGroupById(exported.productGroupId);
        const attrs = (grp as any)?.categoryAttributes;
        categoryMetafields = attrs && Object.keys(attrs).length
          ? { warnings: await setCategoryAttributeMetafields(creds, Number(exported.shopifyProductId), attrs) }
          : { note: "group has no saved categoryAttributes" };
      }
      return { grantedScope, locationId, locationError, testedProductId: exported?.shopifyProductId ?? null, writes, categoryMetafields };
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

      // ── Build the size x color variant matrix (PO 2026-06-11) ───────────────────────────────
      const vendor = await getCredential(input.workspaceId, "shopify", "vendor");
      const concept = await getConceptById(listing.conceptId);
      const tagsStr = (Array.isArray(listing.tags) && listing.tags.length)
        ? listing.tags.join(", ")
        : deriveTags(concept, listing.title);

      // Colours = the colours of the mockups the user selected (render.templateId -> template.colorName).
      const mockupIds: string[] = Array.isArray(listing.mockupRenderIds) ? (listing.mockupRenderIds as string[]) : [];
      const allRenders = concept
        ? [
            ...(await getMockupsByConceptVariation(listing.conceptId, "A")),
            ...(await getMockupsByConceptVariation(listing.conceptId, "B")),
            ...(await getMockupsByConceptVariation(listing.conceptId, "C")),
          ]
        : [];
      const selectedRenders = allRenders.filter((r) => mockupIds.includes(r.id));
      const templates = await getMockupsByGroup(listing.productGroupId);
      const colorByTemplate = new Map(templates.map((t) => [t.id, t.colorName]));
      const colorNames = Array.from(new Set(selectedRenders.map((r) => colorByTemplate.get(r.templateId)).filter((c): c is string => !!c)));

      // Sizes + per-size price from the group's pricing tiers (#2).
      const tiers = (group?.pricingTiers ?? []) as Array<{ sizes: string[]; price: number; cost?: number; compareAt?: number }>;
      const sizePrice = new Map<string, string>();
      const sizeCost = new Map<string, string>();
      const sizeCompareAt = new Map<string, string>();
      for (const tier of tiers) for (const sz of tier.sizes) {
        sizePrice.set(sz, String(tier.price));
        if (tier.cost != null) sizeCost.set(sz, String(tier.cost));
        if (tier.compareAt != null) sizeCompareAt.set(sz, String(tier.compareAt));
      }
      const sizes = Array.from(sizePrice.keys());
      const sizeWeights = (group?.sizeWeights ?? {}) as Record<string, number>; // per-size oz (#6)

      // SKU pieces (#4): BASE(group)-SIZE-COLOR(abbr)-DESIGN(abbr), e.g. 1717-M-ESP-DNK.
      const base = skuBase(group?.name ?? "PRD");
      const designAbbr = abbrev3(concept?.conceptName ?? listing.title);

      // Cross sizes x colours into variants (Shopify REST caps a product at 100 variants).
      const matrix: NonNullable<Parameters<typeof createProduct>[1]["variants"]> = [];
      for (const size of sizes) {
        for (const color of colorNames) {
          if (matrix.length >= 100) break;
          matrix.push({
            option1: size,
            option2: color,
            price: sizePrice.get(size) ?? listing.price ?? "29.99",
            ...(sizeCompareAt.has(size) ? { compare_at_price: sizeCompareAt.get(size)! } : {}), // #3 per-tier MSRP
            ...(sizeWeights[size] != null ? { weight: sizeWeights[size], weight_unit: "oz" as const } : {}), // #6 per-size weight
            sku: `${base}-${size.toUpperCase()}-${abbrev3(color)}-${designAbbr}`,
            inventory_management: "shopify",
            inventory_policy: "continue", // keep selling when out of stock
          });
        }
      }
      const hasMatrix = matrix.length > 0;

      const product = await createProduct(creds, {
        title: listing.title,
        body_html: listing.description ?? "",
        ...(vendor ? { vendor } : {}),
        product_type: (group as any)?.productType ?? "T-Shirt",
        tags: tagsStr,
        status: "draft",
        ...(hasMatrix ? { options: [{ name: "Size" }, { name: "Color" }] } : {}),
        variants: hasMatrix
          ? matrix
          : [{ price: listing.price ?? "29.99", inventory_management: "shopify", inventory_policy: "continue", ...(listing.compareAtPrice ? { compare_at_price: listing.compareAtPrice } : {}) }],
      });

      // Upload each colour's mockup image, LINK it to that colour's variants (#2) so each variant
      // shows its own colour, and set a descriptive per-colour ALT text (SEO/accessibility).
      const productTypeLabel = (group as any)?.productType ?? "T-Shirt";
      for (let i = 0; i < selectedRenders.length; i++) {
        const render = selectedRenders[i]!;
        const color = colorByTemplate.get(render.templateId);
        const variantIds = (product.variants ?? []).filter((v) => v.option2 === color).map((v) => v.id);
        const alt = `May include ${listing.title} ${color ? `in ${color.toLowerCase()} ` : ""}${String(productTypeLabel).toLowerCase()} with ${concept?.conceptName ?? "graphic"} design`;
        try {
          await addProductImageByUrl(creds, product.id, render.compositeUrl, i + 1, variantIds, alt);
        } catch (imgErr) {
          console.warn(`[publishToShopify] Image upload failed for render ${render.id}:`, imgErr);
        }
      }

      // Stock 100/variant + per-tier COGS — ONE bulk GraphQL call each. The old per-variant REST
      // loop (2 calls x 35 variants) blew Shopify's rate limit (burst 40, 2/s) and the TAIL variants
      // silently got stock/cost 0 (PO-reported). Best-effort: never blocks the publish.
      try {
        const locationId = await getPrimaryLocationId(creds);
        const variants = product.variants ?? [];
        if (locationId) {
          try {
            await bulkSetInventory(creds, locationId, variants
              .filter((v) => v.inventory_item_id)
              .map((v) => ({ inventoryItemId: v.inventory_item_id, quantity: 100 })));
          } catch (e) { console.warn(`[publishToShopify] bulk stock set failed:`, e); }
        }
        try {
          await bulkSetVariantCosts(creds, product.id, variants
            .map((v) => ({ variantId: v.id, cost: v.option1 ? sizeCost.get(v.option1) : undefined }))
            .filter((x): x is { variantId: number; cost: string } => !!x.cost));
        } catch (e) { console.warn(`[publishToShopify] bulk cost set failed:`, e); }
      } catch (invErr) {
        console.warn(`[publishToShopify] inventory/cost step failed (non-fatal):`, invErr);
      }

      // Publish to the Online Store + Shop sales channels, not POS (#1). Needs write_publications.
      try {
        await publishProductToChannels(creds, product.id, ["Online Store", "Shop"]);
      } catch (chErr) {
        console.warn(`[publishToShopify] channel publish failed (non-fatal):`, chErr);
      }

      // Product taxonomy category (#2) — the group's mapped category or the T-Shirts default. Required
      // before Shopify can link colour swatches. Best-effort.
      const publishWarnings: string[] = [];
      try {
        await setProductCategory(creds, product.id, (group as any)?.shopifyCategoryGid || TSHIRT_CATEGORY_GID);
      } catch (catErr) {
        console.warn(`[publishToShopify] category set failed (non-fatal):`, catErr);
        publishWarnings.push("Category set failed — swatch linking likely skipped too.");
      }

      // Swatch linking (PO spec 2026-06-12): link the Color/Size options to the shopify taxonomy
      // metafields so the theme renders ROUND COLOUR SWATCHES instead of text pills. Must run AFTER
      // the category is set. Unknown colours attempt metaobject creation, else warn loudly.
      try {
        const colorHexByName: Record<string, string | undefined> = {};
        for (const t of templates) colorHexByName[t.colorName] = (t as any).colorHex ?? undefined;
        publishWarnings.push(...await linkOptionSwatches(creds, product.id, colorHexByName));
      } catch (swErr) {
        console.warn(`[publishToShopify] swatch linking failed (non-fatal):`, swErr);
        publishWarnings.push(`Swatch linking failed: ${String((swErr as any)?.message ?? swErr).slice(0, 160)}`);
      }

      // Category metafields (PO 2026-06-12): the 8 garment facts saved on the product group
      // (age group, neckline, sleeve length, target gender, top length, care, fabric, features) —
      // resolved to taxonomy metaobjects and set on the product. Best-effort.
      try {
        const attrs = (group as any)?.categoryAttributes;
        if (attrs && Object.keys(attrs).length) {
          publishWarnings.push(...await setCategoryAttributeMetafields(creds, product.id, attrs));
        } else {
          publishWarnings.push("No category metafields saved on the product group — fill them on the Product Groups page (AI pre-fill available).");
        }
      } catch (cmErr) {
        console.warn(`[publishToShopify] category metafields failed (non-fatal):`, cmErr);
      }

      // SEO metafields — LLM-generated dedicated meta title/description (PO 2026-06-11).
      // global.title_tag / global.description_tag are Shopify's SEO fields. Best-effort: the
      // product + images already exist, so a meta failure must never block the publish.
      try {
        const meta = await generateSeoMeta(listing.title, listing.description ?? "", tagsStr);
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
        warnings: publishWarnings,
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
