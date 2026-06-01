import { describe, expect, it } from "vitest";

describe("NYT API Key validation", () => {
  it("can fetch bestseller overview from the NYT Books API", async () => {
    const apiKey = process.env.NYT_API_KEY;
    expect(apiKey).toBeTruthy();

    const url = `https://api.nytimes.com/svc/books/v3/lists/overview.json?api-key=${apiKey}`;
    const response = await fetch(url);

    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data).toHaveProperty("status", "OK");
    expect(data).toHaveProperty("results");
    expect(data.results).toHaveProperty("lists");
    expect(Array.isArray(data.results.lists)).toBe(true);
    expect(data.results.lists.length).toBeGreaterThan(0);
  });
});
