import { describe, it, expect } from "vitest";
import {
  computeForumScore,
  extractCrossSourceSignals,
  type ForumSignals,
  type RedditSignal,
  type GoodreadsSignal,
  type StoryGraphSignal,
  type FableSignal,
  type BookRiotSignal,
} from "./forumScraper";

describe("forumScraper module", () => {
  it("exports all 5 scraper functions and helpers", async () => {
    const mod = await import("./forumScraper");
    expect(typeof mod.scrapeReddit).toBe("function");
    expect(typeof mod.scrapeGoodreads).toBe("function");
    expect(typeof mod.scrapeStoryGraph).toBe("function");
    expect(typeof mod.scrapeFable).toBe("function");
    expect(typeof mod.scrapeBookRiot).toBe("function");
    expect(typeof mod.scrapeAllForums).toBe("function");
    expect(typeof mod.computeForumScore).toBe("function");
    expect(typeof mod.extractCrossSourceSignals).toBe("function");
  });

  it("scrapeAllForums returns all 5 signal types", { timeout: 60_000 }, async () => {
    const mod = await import("./forumScraper");
    const result = await mod.scrapeAllForums("Project Hail Mary", "Andy Weir");
    expect(result).toHaveProperty("reddit");
    expect(result).toHaveProperty("goodreads");
    expect(result).toHaveProperty("storyGraph");
    expect(result).toHaveProperty("fable");
    expect(result).toHaveProperty("bookRiot");
    // Each should have a status field
    expect(result.reddit?.status).toBeDefined();
    expect(result.goodreads?.status).toBeDefined();
    expect(result.storyGraph?.status).toBeDefined();
    expect(result.fable?.status).toBeDefined();
    expect(result.bookRiot?.status).toBeDefined();
    // With LLM-based approach, all should succeed for a known book
    const successCount = [result.reddit, result.goodreads, result.storyGraph, result.fable, result.bookRiot]
      .filter(s => s?.status === "success").length;
    expect(successCount).toBeGreaterThanOrEqual(4); // At least 4/5 should succeed
  });

  it("scrapeAllForums returns skipped status when signal is aborted", async () => {
    const mod = await import("./forumScraper");
    const controller = new AbortController();
    controller.abort(); // Pre-abort
    const result = await mod.scrapeAllForums("Test Book", "Test Author", controller.signal);
    expect(result.reddit?.status).toBe("skipped");
    expect(result.goodreads?.status).toBe("skipped");
    expect(result.storyGraph?.status).toBe("skipped");
    expect(result.fable?.status).toBe("skipped");
    expect(result.bookRiot?.status).toBe("skipped");
  });

  it("v6 uses LLM for all sources (no external API dependencies)", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("server/forumScraper.ts", "utf8");
    expect(source).toContain("invokeLLM");
    // Should NOT contain external API URLs that are unreliable
    expect(source).not.toContain("reddit.com");
    expect(source).not.toContain("goodreads.com");
    expect(source).not.toContain("thestorygraph.com");
    expect(source).not.toContain("fable.co");
    expect(source).not.toContain("bookriot.com");
    expect(source).not.toContain("openlibrary.org");
    expect(source).not.toContain("wikipedia.org");
  });

  it("v6 uses llmAnalysis helper for consistent error handling", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("server/forumScraper.ts", "utf8");
    expect(source).toContain("llmAnalysis");
    expect(source).toContain("LLM_TIMEOUT_MS");
  });
});

describe("computeForumScore", () => {
  it("returns zero boosts when all sources failed", () => {
    const signals: ForumSignals = {
      reddit: { postCount: 0, avgUpvotes: 0, topSubreddits: [], sampleTitles: [], status: "failed" },
      goodreads: { ratingsCount: 0, avgRating: 0, reviewCount: 0, topShelves: [], status: "failed" },
      storyGraph: { moods: [], pace: "", themes: [], status: "failed" },
      fable: { clubCount: 0, discussionCount: 0, status: "failed" },
      bookRiot: { articleCount: 0, articleTitles: [], status: "failed" },
    };
    const result = computeForumScore(signals);
    expect(result.socialMomentumBoost).toBe(0);
    expect(result.audienceSizeBoost).toBe(0);
    expect(result.realDataSources).toHaveLength(0);
  });

  it("gives positive social boost for 5+ Reddit posts", () => {
    const signals: ForumSignals = {
      reddit: { postCount: 10, avgUpvotes: 50, topSubreddits: ["books"], sampleTitles: ["test"], status: "success" },
    };
    const result = computeForumScore(signals);
    expect(result.socialMomentumBoost).toBe(10);
    expect(result.realDataSources).toContain("Reddit");
  });

  it("gives positive audience boost for 50k+ Goodreads ratings", () => {
    const signals: ForumSignals = {
      goodreads: { ratingsCount: 75000, avgRating: 4.2, reviewCount: 5000, topShelves: ["fiction"], status: "success" },
    };
    const result = computeForumScore(signals);
    expect(result.audienceSizeBoost).toBe(15);
    expect(result.realDataSources).toContain("Goodreads");
  });

  it("gives positive audience boost for low Goodreads ratings (LLM-based gives benefit of doubt)", () => {
    const signals: ForumSignals = {
      goodreads: { ratingsCount: 50, avgRating: 3.0, reviewCount: 5, topShelves: [], status: "success" },
    };
    const result = computeForumScore(signals);
    expect(result.audienceSizeBoost).toBe(1); // New books get +1 instead of -5
  });

  it("gives social boost for Fable book clubs", () => {
    const signals: ForumSignals = {
      fable: { clubCount: 3, discussionCount: 10, subjects: [], status: "success" },
    };
    const result = computeForumScore(signals);
    expect(result.socialMomentumBoost).toBe(5);
    expect(result.realDataSources).toContain("Fable");
  });

  it("gives social boost for Book Riot articles", () => {
    const signals: ForumSignals = {
      bookRiot: { articleCount: 4, articleTitles: ["a", "b", "c", "d"], culturalAngles: [], status: "success" },
    };
    const result = computeForumScore(signals);
    expect(result.socialMomentumBoost).toBe(5);
    expect(result.realDataSources).toContain("Book Riot");
  });

  it("clamps combined boosts to [-20, +20]", () => {
    const signals: ForumSignals = {
      reddit: { postCount: 100, avgUpvotes: 500, topSubreddits: ["books"], sampleTitles: [], status: "success" },
      fable: { clubCount: 5, discussionCount: 20, status: "success" },
      bookRiot: { articleCount: 10, articleTitles: ["a", "b", "c"], status: "success" },
    };
    const result = computeForumScore(signals);
    expect(result.socialMomentumBoost).toBeLessThanOrEqual(20);
    expect(result.socialMomentumBoost).toBeGreaterThanOrEqual(-20);
    expect(result.audienceSizeBoost).toBeLessThanOrEqual(20);
    expect(result.audienceSizeBoost).toBeGreaterThanOrEqual(-20);
  });

  it("includes StoryGraph in realDataSources when themes found", () => {
    const signals: ForumSignals = {
      storyGraph: { moods: ["dark", "emotional"], pace: "medium", themes: ["love"], status: "success" },
    };
    const result = computeForumScore(signals);
    expect(result.realDataSources).toContain("StoryGraph");
    expect(result.summary).toContain("themes");
  });

  it("generates a summary string with all successful sources", () => {
    const signals: ForumSignals = {
      reddit: { postCount: 5, avgUpvotes: 30, topSubreddits: ["books"], sampleTitles: [], status: "success" },
      goodreads: { ratingsCount: 20000, avgRating: 4.1, reviewCount: 1000, topShelves: ["fiction"], status: "success" },
    };
    const result = computeForumScore(signals);
    expect(result.summary).toContain("community");
    expect(result.summary).toContain("ratings");
    expect(result.realDataSources).toHaveLength(2);
  });

  it("BookRiotSignal has culturalAngles field", () => {
    const signal: BookRiotSignal = {
      articleCount: 2,
      articleTitles: ["a", "b"],
      culturalAngles: ["sci-fi fans", "gift buyers"],
      status: "success",
    };
    expect(signal.culturalAngles).toHaveLength(2);
  });

  it("FableSignal has subjects field", () => {
    const signal: FableSignal = {
      clubCount: 5,
      discussionCount: 3,
      subjects: ["Science fiction", "Space"],
      status: "success",
    };
    expect(signal.subjects).toHaveLength(2);
  });
});

describe("extractCrossSourceSignals", () => {
  it("returns empty when no sources succeeded", () => {
    const signals: ForumSignals = {
      reddit: { postCount: 0, avgUpvotes: 0, topSubreddits: [], sampleTitles: [], status: "failed" },
      goodreads: { ratingsCount: 0, avgRating: 0, reviewCount: 0, topShelves: [], status: "failed" },
    };
    const result = extractCrossSourceSignals(signals);
    expect(result).toHaveLength(0);
  });

  it("finds cross-source themes when 2+ sources share keywords", () => {
    const signals: ForumSignals = {
      reddit: { postCount: 5, avgUpvotes: 50, topSubreddits: [], sampleTitles: ["space adventure survival"], status: "success" },
      storyGraph: { moods: ["tense"], pace: "fast", themes: ["survival", "space exploration"], status: "success" },
      bookRiot: { articleCount: 2, articleTitles: ["space themed merch"], culturalAngles: [], status: "success" },
    };
    const result = extractCrossSourceSignals(signals);
    // "space" should appear in multiple sources
    const spaceSignal = result.find(r => r.theme === "space");
    expect(spaceSignal).toBeDefined();
    expect(spaceSignal!.sourceCount).toBeGreaterThanOrEqual(2);
  });

  it("returns max 12 signals sorted by sourceCount", () => {
    const signals: ForumSignals = {
      reddit: { postCount: 5, avgUpvotes: 50, topSubreddits: ["romance"], sampleTitles: ["love story romance drama emotional"], status: "success" },
      goodreads: { ratingsCount: 5000, avgRating: 4.0, reviewCount: 100, topShelves: ["romance", "love", "drama", "emotional"], status: "success" },
      storyGraph: { moods: ["romantic", "emotional"], pace: "slow", themes: ["love", "drama", "family"], status: "success" },
      fable: { clubCount: 3, discussionCount: 2, subjects: ["romance", "love", "emotional drama"], status: "success" },
      bookRiot: { articleCount: 2, articleTitles: ["romance fans love this"], culturalAngles: ["romance community"], status: "success" },
    };
    const result = extractCrossSourceSignals(signals);
    expect(result.length).toBeLessThanOrEqual(12);
    // Should be sorted by sourceCount descending
    for (let i = 1; i < result.length; i++) {
      expect(result[i].sourceCount).toBeLessThanOrEqual(result[i - 1].sourceCount);
    }
  });
});
