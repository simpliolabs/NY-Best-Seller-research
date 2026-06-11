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
  variants?: Array<{
    price: string;
    compare_at_price?: string;
    sku?: string;
  }>;
}

export interface ShopifyProduct {
  id: number;
  title: string;
  handle: string;
  status: string;
  admin_graphql_api_id: string;
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

/**
 * Add an image to an existing product by URL.
 * Shopify will fetch the image from the URL and store it.
 */
export async function addProductImageByUrl(
  creds: ShopifyCredentials,
  productId: number,
  imageUrl: string,
  position?: number
): Promise<ShopifyProductImage> {
  const data = await shopifyFetch<{ image: ShopifyProductImage }>(
    creds,
    "POST",
    `products/${productId}/images.json`,
    {
      image: {
        src: imageUrl,
        ...(position !== undefined ? { position } : {}),
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
