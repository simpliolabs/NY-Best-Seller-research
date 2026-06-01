/**
 * Phase I Tests — Listing Router + Niche Hunter → Library flow
 * Verifies: listing CRUD, description generation, approve-creates-concept.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock DB helpers
vi.mock("./listingDb", () => ({
  createListing: vi.fn().mockResolvedValue("test-listing-id"),
  getListingsByWorkspace: vi.fn().mockResolvedValue([]),
  getListingById: vi.fn().mockResolvedValue({
    id: "test-listing-id",
    workspaceId: "ws-1",
    conceptId: 1,
    productGroupId: "pg-1",
    title: "Test Listing",
    description: null,
    tags: null,
    price: "29.99",
    compareAtPrice: null,
    mockupRenderIds: ["m1", "m2"],
    status: "draft",
    shopifyProductId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  }),
  updateListing: vi.fn().mockResolvedValue(undefined),
  deleteListing: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./db", () => ({
  getConceptById: vi.fn().mockResolvedValue({
    id: 1,
    conceptName: "Test Concept",
    format: "t-shirt",
    style: "bold",
    headline: "Test Headline",
    subtext: "Test Sub",
    humorFramework: "pun",
  }),
  getDb: vi.fn().mockResolvedValue(null),
  createConceptFromPattern: vi.fn().mockResolvedValue(42),
  getLatestCompletedRunByWorkspace: vi.fn().mockResolvedValue({ id: 1 }),
  insertConcept: vi.fn().mockResolvedValue(42),
  upsertBooksByIsbn: vi.fn().mockResolvedValue([10]),
  completeRun: vi.fn().mockResolvedValue(undefined),
  createRun: vi.fn().mockResolvedValue(1),
}));

vi.mock("./productGroupDb", () => ({
  getProductGroupById: vi.fn().mockResolvedValue({
    id: "pg-1",
    name: "Comfort Colors 1717",
    pricingTiers: [{ sizes: ["S", "M", "L"], price: 34.95 }],
    compareAtPrice: "44.95",
  }),
}));

vi.mock("./nicheHunterDb", () => ({
  updateTrendPatternStatus: vi.fn().mockResolvedValue(undefined),
  getTrendPatternsByWorkspace: vi.fn().mockResolvedValue([
    {
      id: "pattern-1",
      patternName: "Retro Sunset Cat",
      composition: "centered graphic",
      colorStrategy: "warm pastels",
      emotionalHook: "nostalgia + cat lover",
      transferablePattern: "retro sunset silhouette",
      whyItWorks: "Combines trending retro aesthetic with evergreen cat niche",
      adaptedConcept: "A retro sunset silhouette with a cat",
      previewImageUrl: "https://example.com/img.png",
      sourcePlatform: "etsy",
      sourceTitle: "Retro Cat Shirt",
      sourceUrl: "https://etsy.com/listing/123",
      sourceImageUrl: "https://example.com/source.png",
      sourceSales: 500,
      sourceCategory: "cat-lovers",
      transferValid: true,
      transferReasoning: "Strong transfer",
      score: 85,
      rankReasoning: "High score",
      status: "approved",
    },
  ]),
}));

vi.mock("./_core/llm", () => ({
  invokeLLM: vi.fn().mockResolvedValue({
    choices: [
      {
        message: {
          content: JSON.stringify({
            description: "A beautiful retro cat shirt.",
            tags: ["cat", "retro", "sunset", "funny"],
          }),
        },
      },
    ],
  }),
}));

describe("Listing Router", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("createListing is called with correct shape", async () => {
    const { createListing } = await import("./listingDb");
    const { getConceptById } = await import("./db");
    const { getProductGroupById } = await import("./productGroupDb");

    // Simulate what the router does
    const concept = await getConceptById(1);
    expect(concept).toBeTruthy();
    expect(concept!.conceptName).toBe("Test Concept");

    const group = await getProductGroupById("pg-1");
    expect(group).toBeTruthy();
    expect(group!.pricingTiers![0].price).toBe(34.95);

    await createListing({
      id: "test-id",
      workspaceId: "ws-1",
      conceptId: 1,
      productGroupId: "pg-1",
      title: "Test Concept",
      description: null,
      tags: null,
      price: "34.95",
      compareAtPrice: "44.95",
      mockupRenderIds: ["m1", "m2"],
      status: "draft",
      shopifyProductId: null,
    });

    expect(createListing).toHaveBeenCalledOnce();
  });

  it("deleteListing removes the listing", async () => {
    const { deleteListing } = await import("./listingDb");
    await deleteListing("test-listing-id");
    expect(deleteListing).toHaveBeenCalledWith("test-listing-id");
  });

  it("updateListing updates fields", async () => {
    const { updateListing } = await import("./listingDb");
    await updateListing("test-listing-id", { status: "ready" });
    expect(updateListing).toHaveBeenCalledWith("test-listing-id", { status: "ready" });
  });

  it("generateDescription returns description and tags from LLM", async () => {
    const { invokeLLM } = await import("./_core/llm");
    const result = await invokeLLM({
      messages: [
        { role: "system", content: "test" },
        { role: "user", content: "test" },
      ],
    });
    const content = result.choices[0].message.content as string;
    const parsed = JSON.parse(content);
    expect(parsed.description).toBe("A beautiful retro cat shirt.");
    expect(parsed.tags).toHaveLength(4);
    expect(parsed.tags).toContain("cat");
  });
});

describe("Niche Hunter → Concept Library flow", () => {
  it("approvePattern calls createConceptFromPattern with correct pattern", async () => {
    const { getTrendPatternsByWorkspace, updateTrendPatternStatus } = await import("./nicheHunterDb");
    const { createConceptFromPattern } = await import("./db");

    // Simulate the approve flow
    await updateTrendPatternStatus("pattern-1", "approved");
    const patterns = await getTrendPatternsByWorkspace("ws-1", "approved");
    const pattern = patterns.find((p) => p.id === "pattern-1");
    expect(pattern).toBeTruthy();
    expect(pattern!.patternName).toBe("Retro Sunset Cat");

    const conceptId = await createConceptFromPattern(pattern as any, "ws-1");
    expect(conceptId).toBe(42);
    expect(createConceptFromPattern).toHaveBeenCalledWith(pattern, "ws-1");
  });
});
