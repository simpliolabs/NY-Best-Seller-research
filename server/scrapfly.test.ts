import { describe, it, expect } from "vitest";

describe("Scrapfly API Key Validation", () => {
  it("should authenticate with Scrapfly and return a successful response for a simple URL", async () => {
    const key = process.env.SCRAPFLY_API_KEY;
    expect(key).toBeDefined();
    expect(key!.startsWith("scp-live-")).toBe(true);

    // Lightweight test: scrape a simple page to validate the key works
    const testUrl = encodeURIComponent("https://httpbin.dev/html");
    const response = await fetch(
      `https://api.scrapfly.io/scrape?key=${key}&url=${testUrl}`
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.result).toBeDefined();
    expect(data.result.status_code).toBe(200);
  }, 30000);

  it("should fetch Etsy search page with is_best_seller=true and return listing data", async () => {
    const key = process.env.SCRAPFLY_API_KEY;
    expect(key).toBeDefined();

    const etsyUrl = encodeURIComponent(
      "https://www.etsy.com/search?q=hiking+shirt&is_best_seller=true"
    );
    const response = await fetch(
      `https://api.scrapfly.io/scrape?key=${key}&url=${etsyUrl}&asp=true&render_js=true&country=us`
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.result).toBeDefined();
    expect(data.result.status_code).toBe(200);

    // Verify the HTML contains listing cards
    const html: string = data.result.content;
    expect(html.length).toBeGreaterThan(10000); // Real page, not a redirect

    // Check for data-listing-id attributes (Etsy listing cards)
    const hasListings = html.includes("data-listing-id");
    expect(hasListings).toBe(true);

    // Check for "Bestseller" badge text
    const hasBestseller = html.toLowerCase().includes("bestseller");
    expect(hasBestseller).toBe(true);

    console.log(`HTML length: ${html.length}`);
    console.log(`Has data-listing-id: ${hasListings}`);
    console.log(`Has Bestseller badge: ${hasBestseller}`);
  }, 60000);
});
