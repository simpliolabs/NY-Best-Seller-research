/**
 * etsyScraper.ts
 *
 * Fetches Etsy search page HTML via Scrapfly (residential proxy + JS rendering),
 * parses listing cards and opportunistic JSON-LD, and returns raw candidate tiles.
 *
 * Exported surface:
 *   fetchEtsySearchPage(query, filter) → EtsySearchResult
 *
 * Caller is responsible for Vision LLM selection and second-pass logic.
 * This file does only: fetch + parse + return. No LLM, no fallback, no fiction.
 *
 * Transport: Scrapfly API with asp=true (anti-scraping protection bypass),
 * render_js=true (headless browser rendering), country=us.
 * Wall-clock per page: ~36s (measured). Budget for 8 categories: ~288s.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface EtsyTile {
  listingId: string;
  title: string;
  thumbnailUrl: string;      // il_794xN — used for Vision LLM input
  fullResUrl: string;        // il_fullxfull — from string-replace or JSON-LD
  listingUrl: string;        // canonical URL from card href or JSON-LD
  reviewCount: number;       // parsed from "(23.2k)" → 23200; 0 if not found
  badge: string;             // "Bestseller" | "Popular now" | "url_filtered"
}

export type EtsySearchFilter = "is_best_seller" | "is_popular_now";

export interface EtsySearchResult {
  tiles: EtsyTile[];
  scraperBroken: boolean;    // true if selector absent on rendered page
  pageRendered: boolean;     // true if Scrapfly returned a real Etsy page
  errorMessage: string | null;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const LISTING_SELECTOR = "data-listing-id";
const TILE_CAP = 12;
const SCRAPFLY_TIMEOUT_MS = 90_000; // 90s fetch timeout (Scrapfly renders in ~36s)

// Badge selector: Etsy renders badges as <clg-signal color="neutral" size="large">Bestseller</clg-signal>
const BADGE_REGEX = /<clg-signal[^>]*>\s*(Bestseller|Popular now)\s*<\/clg-signal>/g;

// ─── Main export ──────────────────────────────────────────────────────────────

export async function fetchEtsySearchPage(
  searchQuery: string,
  filter: EtsySearchFilter
): Promise<EtsySearchResult> {
  const apiKey = process.env.SCRAPFLY_API_KEY;
  if (!apiKey) {
    return {
      tiles: [],
      scraperBroken: false,
      pageRendered: false,
      errorMessage: "SCRAPFLY_API_KEY not set — cannot fetch Etsy pages",
    };
  }

  const encodedQuery = encodeURIComponent(searchQuery);
  const filterParam = filter === "is_best_seller" ? "is_best_seller=true" : "is_popular_now=true";
  const etsyUrl = `https://www.etsy.com/search?q=${encodedQuery}&explicit=1&${filterParam}`;

  // Build Scrapfly API URL
  const params = new URLSearchParams({
    key: apiKey,
    url: etsyUrl,
    asp: "true",           // Anti-scraping protection bypass
    render_js: "true",     // Headless browser rendering (required for Etsy)
    country: "us",         // US residential proxy
  });
  const scrapflyUrl = `https://api.scrapfly.io/scrape?${params.toString()}`;

  let html: string;
  let httpStatus: number;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SCRAPFLY_TIMEOUT_MS);

    const response = await fetch(scrapflyUrl, { signal: controller.signal });
    clearTimeout(timeout);

    httpStatus = response.status;

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      return {
        tiles: [],
        scraperBroken: false,
        pageRendered: false,
        errorMessage: `Scrapfly HTTP ${httpStatus}: ${body.slice(0, 200)}`,
      };
    }

    const data = await response.json() as {
      result?: { status_code?: number; content?: string };
    };

    const resultStatus = data.result?.status_code ?? 0;
    html = data.result?.content ?? "";

    if (resultStatus !== 200 || !html) {
      return {
        tiles: [],
        scraperBroken: false,
        pageRendered: false,
        errorMessage: `Scrapfly returned upstream status ${resultStatus}, content length ${html.length}`,
      };
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      tiles: [],
      scraperBroken: false,
      pageRendered: false,
      errorMessage: `Scrapfly fetch error: ${msg}`,
    };
  }

  // ─── Validate page rendered correctly ──────────────────────────────────────

  // Check for DataDome / captcha challenge (should not happen with asp=true, but detect it)
  if (html.includes("captcha-delivery.com") || html.includes("geo.captcha-delivery.com")) {
    return {
      tiles: [],
      scraperBroken: false,
      pageRendered: false,
      errorMessage: "DataDome captcha challenge detected — Scrapfly ASP did not bypass",
    };
  }

  // Check if the page has listing cards
  if (!html.includes(LISTING_SELECTOR)) {
    // Page rendered but no listing cards — check if it's a real Etsy page
    const titleMatch = html.match(/<title>([^<]*)<\/title>/);
    const title = titleMatch ? titleMatch[1] : "";

    if (title.toLowerCase().includes("etsy") || html.length > 50_000) {
      // Etsy page rendered but selector structure changed
      return {
        tiles: [],
        scraperBroken: true,
        pageRendered: true,
        errorMessage: `SCRAPER_BROKEN: "${LISTING_SELECTOR}" not present on rendered page (title: "${title}", html length: ${html.length}) — Etsy HTML structure may have changed.`,
      };
    }

    return {
      tiles: [],
      scraperBroken: false,
      pageRendered: false,
      errorMessage: `Page did not render Etsy content (title: "${title}", html length: ${html.length})`,
    };
  }

  // ─── Parse the rendered HTML ───────────────────────────────────────────────

  const tiles = parseSearchPage(html, filter);

  return { tiles, scraperBroken: false, pageRendered: true, errorMessage: null };
}

// ─── Puppeteer lifecycle stubs (no-ops for backward compat) ──────────────────

/** @deprecated Scrapfly transport does not use a browser. Kept for interface compat. */
export async function openBrowser(): Promise<void> {
  // No-op: Scrapfly is stateless HTTP
}

/** @deprecated Scrapfly transport does not use a browser. Kept for interface compat. */
export async function closeBrowser(): Promise<void> {
  // No-op: Scrapfly is stateless HTTP
}

// ─── HTML Parser ──────────────────────────────────────────────────────────────

function parseSearchPage(html: string, filter: EtsySearchFilter): EtsyTile[] {
  // Parse JSON-LD for canonical URLs and full-res images (opportunistic)
  const jsonLdMap = extractJsonLdMap(html);

  // The Etsy page has two sections:
  // 1. Skeleton cards (data-listing-card-v2 attributes, no content)
  // 2. Rendered cards (further down, with images, titles, badges)
  // We need to find the rendered section — look for cards with listing-link class

  const cardMatches = Array.from(
    html.matchAll(/class="listing-link[^"]*"[^>]*data-listing-id="(\d+)"/g)
  );
  const seenIds = new Set<string>();
  const tiles: EtsyTile[] = [];

  for (const match of cardMatches) {
    if (tiles.length >= TILE_CAP) break;

    const listingId = match[1];
    if (seenIds.has(listingId)) continue;
    seenIds.add(listingId);

    // Extract the surrounding card HTML (16000 chars forward — review counts are ~6-15k chars deep in rendered cards)
    const startIdx = match.index ?? 0;
    const cardChunk = html.slice(startIdx, startIdx + 16000);

    const thumbnailUrl = extractThumbnailUrl(cardChunk);
    if (!thumbnailUrl) continue;

    const fullResUrl = jsonLdMap.get(listingId)?.image ?? upgradeToFullRes(thumbnailUrl);
    const listingUrl = extractListingUrl(cardChunk) ?? jsonLdMap.get(listingId)?.url ?? `https://www.etsy.com/listing/${listingId}`;
    const title = extractTitle(cardChunk) ?? jsonLdMap.get(listingId)?.name ?? "";
    const reviewCount = extractReviewCount(cardChunk);
    const badge = extractBadge(cardChunk, filter);

    tiles.push({ listingId, title, thumbnailUrl, fullResUrl, listingUrl, reviewCount, badge });
  }

  return tiles;
}

// ─── JSON-LD extractor ────────────────────────────────────────────────────────

interface JsonLdEntry {
  image: string;
  url: string;
  name: string;
}

function extractJsonLdMap(html: string): Map<string, JsonLdEntry> {
  const map = new Map<string, JsonLdEntry>();
  const scriptMatches = Array.from(html.matchAll(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g));

  for (const scriptMatch of scriptMatches) {
    try {
      const parsed = JSON.parse(scriptMatch[1]);
      if (parsed["@type"] !== "ItemList") continue;
      const items: unknown[] = parsed.itemListElement ?? [];
      for (const item of items) {
        const product = (item as { item?: { "@type"?: string; image?: string; url?: string; name?: string } }).item;
        if (!product || product["@type"] !== "Product") continue;
        const image = product.image ?? "";
        const url = product.url ?? "";
        const name = product.name ?? "";
        // Extract listing ID from URL
        const idMatch = url.match(/\/listing\/(\d+)\//);
        if (idMatch && image && url) {
          map.set(idMatch[1], { image, url, name });
        }
      }
    } catch {
      // Malformed JSON-LD — skip silently
    }
  }

  return map;
}

// ─── Card field extractors ────────────────────────────────────────────────────

function extractThumbnailUrl(cardChunk: string): string | null {
  // Match il_794xN (the standard search card size) or il_300x300 or il_340x270
  const imgMatch = cardChunk.match(/src="(https:\/\/i\.etsystatic\.com\/[^"]+il_794xN[^"]+\.jpg)"/);
  if (imgMatch) return imgMatch[1];
  // Fallback: any Etsy CDN image
  const fallbackMatch = cardChunk.match(/src="(https:\/\/i\.etsystatic\.com\/[^"]+il_\d+x[^"]+\.jpg)"/);
  return fallbackMatch ? fallbackMatch[1] : null;
}

function upgradeToFullRes(thumbnailUrl: string): string {
  // Replace the size segment (il_794xN, il_300x300, il_340x270, etc.) with il_fullxfull
  return thumbnailUrl.replace(/il_\d+x[A-Za-z0-9]+/, "il_fullxfull");
}

function extractListingUrl(cardChunk: string): string | null {
  const match = cardChunk.match(/href="(https:\/\/www\.etsy\.com\/listing\/\d+\/[^"]+)"/);
  return match ? match[1] : null;
}

function extractTitle(cardChunk: string): string | null {
  // Primary: alt attribute on the listing image (most reliable in rendered cards)
  const altMatch = cardChunk.match(/alt="([^"]{10,200})"/);
  if (altMatch) return altMatch[1].trim();
  // Fallback: aria-label on the link
  const ariaMatch = cardChunk.match(/aria-label="([^"]{5,200})"/);
  if (ariaMatch) return ariaMatch[1].trim();
  return null;
}

function extractReviewCount(cardChunk: string): number {
  // Primary: aria-label on the star rating div — "4.9 star rating with 1.3k reviews"
  const ariaMatch = cardChunk.match(/aria-label="[\d.]+ star rating with ([\d,.]+[kK]?) reviews?"/);
  if (ariaMatch) return parseReviewString(ariaMatch[1]);

  // Fallback: <p class="wt-text-body-smaller">(1.3k)</p> inside the rating block
  const pMatch = cardChunk.match(/class="wt-text-body-smaller">\(([\d,.]+[kK]?)\)<\/p>/);
  if (pMatch) return parseReviewString(pMatch[1]);

  // Last resort: any parenthesized number that looks like a review count
  const parenMatch = cardChunk.match(/\((\d[\d,]*\.?\d*[kK]?)\)/);
  if (parenMatch) return parseReviewString(parenMatch[1]);

  return 0;
}

function parseReviewString(raw: string): number {
  const cleaned = raw.replace(/,/g, "");
  if (cleaned.toLowerCase().endsWith("k")) {
    return Math.round(parseFloat(cleaned) * 1000);
  }
  return parseInt(cleaned, 10) || 0;
}

function extractBadge(cardChunk: string, filter: EtsySearchFilter): string {
  // Use <clg-signal> element — the canonical badge selector on Etsy search pages
  const badgeMatch = cardChunk.match(/<clg-signal[^>]*>\s*(Bestseller|Popular now)\s*<\/clg-signal>/);
  if (badgeMatch) return badgeMatch[1];
  // URL filter is the authoritative gate — if badge text is missing, note it
  return filter === "is_best_seller" ? "url_filtered" : "url_filtered_popular";
}
