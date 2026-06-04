# Action B: Research Findings — Etsy Data Sourcing Alternatives

## DataDome Confirmation (Action A)
- HTTP Status: 403
- All 5 DataDome markers present (captcha-delivery.com, geo.captcha-delivery.com, DataDome, dd={'rt', data-cfasync)
- Stack tested: puppeteer-core + @sparticuz/chromium + puppeteer-extra-plugin-stealth
- VERDICT: BLOCKED. Cannot bypass from cloud IP.

## Option 1: Bright Data Etsy Scraper API
- **What it does:** Structured Etsy data extraction (product URL, title, rating, reviews_count_shop, reviews_count_item, initial_price, product_id, listing_inventory_id)
- **Handles DataDome:** Yes — automated proxy management, full browser rendering, CAPTCHA solving
- **Returns images:** Yes (product images listed as a data field)
- **Pricing:**
  - Free trial: 1K records (one-time, 7 days)
  - Pay-as-you-go: $1.50/1K records
  - Scale: $499/month for 384K records ($1.30/1K additional)
- **Search support:** Yes — "Etsy - Collect data on products using specified keywords" scraper available
- **Bestseller filter:** Unclear — need to test if search URL with is_best_seller=true works
- **Output format:** JSON or CSV via webhook/API delivery
- **Limitation:** Returns structured data, not raw HTML. Fields are pre-defined. Need to verify if "bestseller badge" is included.

## Option 2: Decodo (formerly Smartproxy) Etsy Scraper API
- **What it does:** Web Scraping API that returns HTML, then uses "AI Parser" to convert to JSON
- **Returns:** Product titles, descriptions, pricing, images, seller info, reviews, ratings, attributes, stock, shipping
- **Handles DataDome:** Claims to — "no CAPTCHAs, no IP blocks"
- **Search/pagination/filtering:** Supported
- **Pricing:** Not found on page — need to check pricing page
- **Output:** HTML format (requires AI Parser for JSON)

## Option 3: ScraperAPI
- **Etsy success rate (Scrapeway benchmark):** 98%
- **Cost:** $4.90/1K requests
- **Speed:** 4.1s per request
- **How it works:** Proxy + render service — you send the URL, get back rendered HTML
- **DataDome bypass:** Yes (98% success rate on Etsy per independent benchmark)
- **Returns:** Raw rendered HTML — you parse it yourself (same as our existing Puppeteer parser)
- **Pricing:** $49/month for 100K credits, $99/month for 250K credits
- **Credit multiplier for JS rendering:** 5x (so 100K credits = 20K rendered pages)
- **Ultra Premium domains (DataDome sites):** Additional multiplier — ~$7/1K requests with rendering

## Option 4: Scrapfly
- **Etsy success rate (Scrapeway benchmark):** 100% (best performer)
- **Cost:** $3.85/1K requests
- **Speed:** 3.9s per request
- **How it works:** Similar to ScraperAPI — proxy + render, returns HTML
- **DataDome bypass:** Yes (100% success rate)
- **Returns:** Raw rendered HTML

## Option 5: eRank / Marmalead
- **NO developer API.** These are SaaS tools with web UIs only.
- eRank: $7.92/month (Pro) or $22.50/month (Expert) — web dashboard only
- Marmalead: $19/month — web dashboard only, no API access
- Neither exposes bestseller listings programmatically with product images via API

## Scan Cost Estimate
- Per scan: 8 categories × 1 search page = 8 requests (pass 1)
- Worst case with pass 2: 8 + 8 = 16 requests
- Monthly (2 workspaces × 2 scans/week × 4 weeks): ~128 requests/month

| Service | Cost/1K | Monthly cost (128 req) | Annual |
|---------|---------|----------------------|--------|
| Bright Data (structured) | $1.50 | $0.19 | $2.30 |
| Scrapfly (HTML) | $3.85 | $0.49 | $5.91 |
| ScraperAPI (HTML) | $4.90 | $0.63 | $7.53 |

At 128 requests/month, ALL options cost < $1/month. Even at 10x scale (1,280 req/month), costs are < $7/month.
