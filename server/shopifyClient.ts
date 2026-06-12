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

  const res = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": creds.accessToken,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

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

/**
 * Add an image to an existing product by URL.
 * Shopify will fetch the image from the URL and store it.
 */
export async function addProductImageByUrl(
  creds: ShopifyCredentials,
  productId: number,
  imageUrl: string,
  position?: number,
  variantIds?: number[]
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
