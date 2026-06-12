/**
 * shopifyClient.ts
 *
 * Thin Shopify Admin REST API v2024-01 client.
 * All calls are server-side only — credentials never leave the backend.
 *
 * Private App auth: X-Shopify-Access-Token header (shpat_* token).
 * Store domain must be the myshopify.com subdomain, e.g. "my-store.myshopify.com".
 */

const API_VERSION = "2024-01";
// GraphQL needs a newer version for the product-taxonomy `category` field + the productUpdate(product:)
// form. REST stays on 2024-01 (the rest of this client relies on its behaviour).
const GRAPHQL_API_VERSION = "2025-01";

export interface ShopifyCredentials {
  storeDomain: string; // e.g. "my-store.myshopify.com"
  accessToken: string; // shpat_* Private App token
}

export interface ShopifyShop {
  id: number;
  name: string;
  email: string;
  domain: string;
  myshopify_domain: string;
  plan_name: string;
}

export interface ShopifyProductInput {
  title: string;
  body_html: string;
  vendor?: string;
  product_type?: string;
  tags?: string; // comma-separated
  status?: "active" | "draft" | "archived";
  /** Product options, e.g. [{name:"Size"},{name:"Color"}] — required for a size x color matrix. */
  options?: Array<{ name: string }>;
  variants?: Array<{
    price: string;
    compare_at_price?: string;
    sku?: string;
    option1?: string;
    option2?: string;
    option3?: string;
    inventory_management?: "shopify" | null;
    inventory_policy?: "deny" | "continue";
    weight?: number;
    weight_unit?: "g" | "kg" | "oz" | "lb";
  }>;
}

export interface ShopifyProduct {
  id: number;
  title: string;
  handle: string;
  status: string;
  admin_graphql_api_id: string;
  variants?: Array<{
    id: number;
    sku: string | null;
    option1: string | null;
    option2: string | null;
    inventory_item_id: number;
  }>;
}

export interface ShopifyProductImage {
  id: number;
  product_id: number;
  src: string;
  position: number;
}

// ─── Core fetch wrapper ────────────────────────────────────────────────────

async function shopifyFetch<T>(
  creds: ShopifyCredentials,
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown
): Promise<T> {
  const domain = creds.storeDomain.replace(/^https?:\/\//, "").replace(/\/$/, "");
  const url = `https://${domain}/admin/api/${API_VERSION}/${path}`;

  let res!: Response;
  // Shopify REST leaks 2 req/s (burst 40): a 35-variant publish used to 429 on the tail variants
  // (PO saw the LAST variants with stock/cost 0). Retry 429s honouring Retry-After.
  for (let attempt = 0; attempt < 6; attempt++) {
    res = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": creds.accessToken,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.status !== 429) break;
    const waitS = Number(res.headers.get("Retry-After")) || 2;
    await new Promise((r) => setTimeout(r, Math.min(waitS, 10) * 1000));
  }

  if (!res.ok) {
    let errMsg = `Shopify API error ${res.status}`;
    try {
      const errBody = (await res.json()) as { errors?: unknown };
      if (errBody.errors) {
        errMsg += `: ${typeof errBody.errors === "string" ? errBody.errors : JSON.stringify(errBody.errors)}`;
      }
    } catch {
      // ignore parse failure
    }
    throw new Error(errMsg);
  }

  return res.json() as Promise<T>;
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Verify credentials by fetching the shop info.
 * Returns the shop object on success; throws on invalid credentials.
 */
export async function getShop(creds: ShopifyCredentials): Promise<ShopifyShop> {
  const data = await shopifyFetch<{ shop: ShopifyShop }>(creds, "GET", "shop.json");
  return data.shop;
}

/**
 * Create a new product in the Shopify store.
 * Returns the created product.
 */
export async function createProduct(
  creds: ShopifyCredentials,
  input: ShopifyProductInput
): Promise<ShopifyProduct> {
  const data = await shopifyFetch<{ product: ShopifyProduct }>(creds, "POST", "products.json", {
    product: input,
  });
  return data.product;
}

/** Primary (first active) inventory location id — needed to set stock levels. */
export async function getPrimaryLocationId(creds: ShopifyCredentials): Promise<number | null> {
  const data = await shopifyFetch<{ locations: Array<{ id: number; active: boolean }> }>(creds, "GET", "locations.json");
  const active = data.locations.find((l) => l.active) ?? data.locations[0];
  return active?.id ?? null;
}

/** Set a variant's available stock at a location (Shopify removed inventory_quantity from variant
 *  create in 2022-07, so stock must be set via the InventoryLevel resource). */
export async function setInventoryLevel(
  creds: ShopifyCredentials,
  locationId: number,
  inventoryItemId: number,
  available: number
): Promise<void> {
  await shopifyFetch(creds, "POST", "inventory_levels/set.json", {
    location_id: locationId,
    inventory_item_id: inventoryItemId,
    available,
  });
}

/** Set the cost (COGS) on a variant's inventory item. */
export async function setInventoryItemCost(
  creds: ShopifyCredentials,
  inventoryItemId: number,
  cost: string
): Promise<void> {
  await shopifyFetch(creds, "PUT", `inventory_items/${inventoryItemId}.json`, {
    inventory_item: { id: inventoryItemId, cost },
  });
}

/** Minimal GraphQL caller — REST can't manage sales-channel publications. */
async function shopifyGraphQL<T>(creds: ShopifyCredentials, query: string, variables?: Record<string, unknown>): Promise<T> {
  const domain = creds.storeDomain.replace(/^https?:\/\//, "").replace(/\/$/, "");
  const res = await fetch(`https://${domain}/admin/api/${GRAPHQL_API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": creds.accessToken },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`Shopify GraphQL error ${res.status}`);
  const json = (await res.json()) as { data?: T; errors?: unknown };
  if (json.errors) throw new Error(`Shopify GraphQL: ${JSON.stringify(json.errors)}`);
  return json.data as T;
}

/** Publish a product to named sales channels, e.g. ["Online Store","Shop"]. Best-effort; needs the
 *  write_publications scope. Looks up each channel's publication id, then publishablePublish. */
export async function publishProductToChannels(
  creds: ShopifyCredentials,
  productId: number,
  channelNames: string[]
): Promise<void> {
  const pubs = await shopifyGraphQL<{ publications: { edges: Array<{ node: { id: string; name: string } }> } }>(
    creds,
    "{ publications(first: 25) { edges { node { id name } } } }"
  );
  const wanted = new Set(channelNames.map((n) => n.toLowerCase()));
  const id = `gid://shopify/Product/${productId}`;
  const toPublish = pubs.publications.edges.filter((e) => wanted.has(e.node.name.toLowerCase())).map((e) => ({ publicationId: e.node.id }));
  const toUnpublish = pubs.publications.edges.filter((e) => !wanted.has(e.node.name.toLowerCase())).map((e) => ({ publicationId: e.node.id }));
  if (toPublish.length) {
    await shopifyGraphQL(creds, "mutation P($id: ID!, $input: [PublicationInput!]!){ publishablePublish(id:$id,input:$input){ userErrors{ message } } }", { id, input: toPublish });
  }
  if (toUnpublish.length) {
    // remove POS / any other channel — the PO wants EXACTLY the named channels
    await shopifyGraphQL(creds, "mutation U($id: ID!, $input: [PublicationInput!]!){ publishableUnpublish(id:$id,input:$input){ userErrors{ message } } }", { id, input: toUnpublish });
  }
}

/** T-Shirts in Shopify's product taxonomy — the default category when a group hasn't mapped one. */
export const TSHIRT_CATEGORY_GID = "gid://shopify/TaxonomyCategory/aa-1-13-8";

/** Set the product's taxonomy category (required before colour swatches can link). Best-effort. */
export async function setProductCategory(creds: ShopifyCredentials, productId: number, categoryGid: string): Promise<void> {
  await shopifyGraphQL(
    creds,
    "mutation C($product: ProductUpdateInput!){ productUpdate(product: $product){ userErrors{ field message } } }",
    { product: { id: `gid://shopify/Product/${productId}`, category: categoryGid } }
  );
}

/** Set stock for MANY variants in ONE GraphQL call (inventorySetQuantities). The per-variant REST
 *  loop hit Shopify's rate limit on 35-variant products — the tail variants silently got 0. */
export async function bulkSetInventory(
  creds: ShopifyCredentials,
  locationId: number,
  items: Array<{ inventoryItemId: number; quantity: number }>
): Promise<void> {
  if (!items.length) return;
  await shopifyGraphQL(
    creds,
    "mutation Set($input: InventorySetQuantitiesInput!){ inventorySetQuantities(input: $input){ userErrors{ field message } } }",
    {
      input: {
        name: "available",
        reason: "correction",
        ignoreCompareQuantity: true,
        quantities: items.map((i) => ({
          inventoryItemId: `gid://shopify/InventoryItem/${i.inventoryItemId}`,
          locationId: `gid://shopify/Location/${locationId}`,
          quantity: i.quantity,
        })),
      },
    }
  );
}

/** Set per-variant COGS for MANY variants in ONE GraphQL call (productVariantsBulkUpdate). */
export async function bulkSetVariantCosts(
  creds: ShopifyCredentials,
  productId: number,
  items: Array<{ variantId: number; cost: string }>
): Promise<void> {
  if (!items.length) return;
  await shopifyGraphQL(
    creds,
    "mutation Upd($productId: ID!, $variants: [ProductVariantsBulkInput!]!){ productVariantsBulkUpdate(productId: $productId, variants: $variants){ userErrors{ field message } } }",
    {
      productId: `gid://shopify/Product/${productId}`,
      variants: items.map((i) => ({ id: `gid://shopify/ProductVariant/${i.variantId}`, inventoryItem: { cost: i.cost } })),
    }
  );
}

// ─── Swatch linking (PO spec 2026-06-12, verified 3x on this store) ────────────────────────────
// Linking Color/Size options to Shopify's taxonomy metafields is what renders ROUND COLOUR SWATCHES
// instead of text pills. Metaobject GIDs are store-specific but permanent — hardcoded per the spec;
// an unknown colour attempts metaobjectCreate (needs write_metaobjects; logs loudly on failure).

const COLOR_SWATCH_GIDS: Record<string, string> = {
  "espresso": "gid://shopify/Metaobject/213371683000",
  "black": "gid://shopify/Metaobject/213371715768",
  "ivory": "gid://shopify/Metaobject/214359474360",
  "mustard": "gid://shopify/Metaobject/214504964280",
  "yam": "gid://shopify/Metaobject/214504997048",
  "watermelon": "gid://shopify/Metaobject/214505062584",
  "white": "gid://shopify/Metaobject/214505095352",
  "berry": "gid://shopify/Metaobject/214506700984",
  "lagoon": "gid://shopify/Metaobject/214506733752",
  "bay": "gid://shopify/Metaobject/214506766520",
  "light green": "gid://shopify/Metaobject/214506799288",
  "blue jean": "gid://shopify/Metaobject/214506832056",
  "gray": "gid://shopify/Metaobject/214506897592",
};

const SIZE_SWATCH_GIDS: Record<string, string> = {
  "S": "gid://shopify/Metaobject/213371748536",
  "M": "gid://shopify/Metaobject/213371781304",
  "L": "gid://shopify/Metaobject/213371814072",
  "XL": "gid://shopify/Metaobject/213371846840",
  "2XL": "gid://shopify/Metaobject/213371879608",
  "3XL": "gid://shopify/Metaobject/213371912376",
  "4XL": "gid://shopify/Metaobject/213371945144",
};

/** Try to CREATE a colour-pattern metaobject for a colour not in the table (new colours). Needs the
 *  write_metaobjects scope — returns null (with a loud log) if Shopify refuses. */
async function createColorSwatchMetaobject(creds: ShopifyCredentials, colorName: string, colorHex?: string): Promise<string | null> {
  try {
    const data = await shopifyGraphQL<{ metaobjectCreate: { metaobject: { id: string } | null; userErrors: Array<{ message: string }> } }>(
      creds,
      "mutation MC($metaobject: MetaobjectCreateInput!){ metaobjectCreate(metaobject: $metaobject){ metaobject{ id } userErrors{ field message } } }",
      { metaobject: { type: "shopify--color-pattern", fields: [
        { key: "label", value: colorName },
        ...(colorHex ? [{ key: "color", value: colorHex }] : []),
      ] } }
    );
    const errs = data.metaobjectCreate?.userErrors ?? [];
    if (errs.length) { console.error(`[SWATCH] create '${colorName}' failed:`, JSON.stringify(errs)); return null; }
    return data.metaobjectCreate?.metaobject?.id ?? null;
  } catch (e: any) {
    console.error(`[SWATCH] create '${colorName}' failed (likely missing write_metaobjects scope):`, String(e?.message ?? e).slice(0, 200));
    return null;
  }
}

/** Link the product's Color + Size options to the taxonomy metafields (round swatches). Category must
 *  already be set. ALL values of an option must map or that option is skipped (partial mapping fails
 *  the whole mutation). Returns human-readable warnings for anything skipped. */
export async function linkOptionSwatches(
  creds: ShopifyCredentials,
  productId: number,
  colorHexByName?: Record<string, string | undefined>
): Promise<string[]> {
  const warnings: string[] = [];
  const gid = `gid://shopify/Product/${productId}`;
  const data = await shopifyGraphQL<{ product: { options: Array<{ id: string; name: string; optionValues: Array<{ id: string; name: string }> }> } }>(
    creds,
    "query GetOptionIds($id: ID!){ product(id: $id){ options{ id name optionValues{ id name } } } }",
    { id: gid }
  );

  for (const opt of data.product?.options ?? []) {
    const kind = opt.name.toLowerCase() === "color" ? "color-pattern" : opt.name.toLowerCase() === "size" ? "size" : null;
    if (!kind) continue;
    const values: Array<{ id: string; linkedMetafieldValue: string }> = [];
    let allMapped = true;
    for (const v of opt.optionValues) {
      let mGid = kind === "size" ? SIZE_SWATCH_GIDS[v.name.toUpperCase()] : COLOR_SWATCH_GIDS[v.name.toLowerCase()];
      if (!mGid && kind === "color-pattern") {
        mGid = (await createColorSwatchMetaobject(creds, v.name, colorHexByName?.[v.name])) ?? undefined as any;
      }
      if (!mGid) {
        console.error(`[SWATCH] no metaobject GID for ${opt.name} value '${v.name}' — option NOT linked`);
        warnings.push(`Swatch not linked: unknown ${opt.name} '${v.name}' (add it to the table or grant write_metaobjects)`);
        allMapped = false;
        break;
      }
      values.push({ id: v.id, linkedMetafieldValue: mGid });
    }
    if (!allMapped) continue;
    const res = await shopifyGraphQL<{ productOptionUpdate: { userErrors: Array<{ message: string; code?: string }> } }>(
      creds,
      `mutation Link($productId: ID!, $optionId: ID!, $values: [OptionValueUpdateInput!]!){
        productOptionUpdate(
          productId: $productId,
          option: { id: $optionId, linkedMetafield: { namespace: "shopify", key: "${kind}" } },
          optionValuesToUpdate: $values
        ){ userErrors{ field message code } } }`,
      { productId: gid, optionId: opt.id, values }
    );
    const errs = res.productOptionUpdate?.userErrors ?? [];
    if (errs.length) {
      console.error(`[SWATCH] link ${opt.name} failed:`, JSON.stringify(errs));
      warnings.push(`Swatch link failed for ${opt.name}: ${errs.map((e) => e.message).join("; ")}`);
    }
  }
  return warnings;
}

/** TEMP diagnostic (PO 2026-06-12): test the inventory WRITE calls on a product's first variant and
 *  return the exact error — distinguishes a 403 (scope) from a 422 (item not stocked at location) from
 *  an untracked variant. Read of the product + two writes on ONE variant. */
export async function diagnoseInventoryWrites(creds: ShopifyCredentials, productId: number): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  try {
    const data = await shopifyFetch<{ product: { variants: Array<{ id: number; inventory_item_id: number; inventory_management: string | null }> } }>(creds, "GET", `products/${productId}.json`);
    const v = data.product.variants[0];
    out.inventoryItemId = v?.inventory_item_id ?? null;
    out.inventory_management = v?.inventory_management ?? null;
    const loc = await getPrimaryLocationId(creds);
    out.locationId = loc;
    if (loc && v?.inventory_item_id) {
      try { await setInventoryLevel(creds, loc, v.inventory_item_id, 100); out.stockSet = "OK"; }
      catch (e: any) { out.stockError = String(e?.message ?? e).slice(0, 300); }
      try { await setInventoryItemCost(creds, v.inventory_item_id, "9.99"); out.costSet = "OK"; }
      catch (e: any) { out.costError = String(e?.message ?? e).slice(0, 300); }
    }
  } catch (e: any) { out.fetchError = String(e?.message ?? e).slice(0, 300); }
  return out;
}

/**
 * Add an image to an existing product by URL.
 * Shopify will fetch the image from the URL and store it.
 */
export async function addProductImageByUrl(
  creds: ShopifyCredentials,
  productId: number,
  imageUrl: string,
  position?: number,
  variantIds?: number[],
  alt?: string
): Promise<ShopifyProductImage> {
  const data = await shopifyFetch<{ image: ShopifyProductImage }>(
    creds,
    "POST",
    `products/${productId}/images.json`,
    {
      image: {
        src: imageUrl,
        ...(position !== undefined ? { position } : {}),
        ...(variantIds && variantIds.length ? { variant_ids: variantIds } : {}),
        ...(alt ? { alt } : {}),
      },
    }
  );
  return data.image;
}

/**
 * Set (create) a metafield on a product. Used for Shopify's SEO fields:
 *   namespace "global", key "title_tag"        → SEO meta title
 *   namespace "global", key "description_tag"  → SEO meta description
 */
export async function setProductMetafield(
  creds: ShopifyCredentials,
  productId: number,
  namespace: string,
  key: string,
  value: string,
  type: string = "single_line_text_field"
): Promise<void> {
  await shopifyFetch(creds, "POST", `products/${productId}/metafields.json`, {
    metafield: { namespace, key, value, type },
  });
}

/**
 * Update an existing product (e.g. change status to active).
 */
export async function updateProduct(
  creds: ShopifyCredentials,
  productId: number,
  fields: Partial<ShopifyProductInput>
): Promise<ShopifyProduct> {
  const data = await shopifyFetch<{ product: ShopifyProduct }>(
    creds,
    "PUT",
    `products/${productId}.json`,
    { product: { id: productId, ...fields } }
  );
  return data.product;
}
