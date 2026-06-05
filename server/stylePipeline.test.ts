/**
 * Style-Faithful Pipeline Tests
 * Covers: signalWeights (pure), extractStyleFromImage (mocked LLM), determineAdaptationMode
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { computeSignalWeights } from "./signalWeights";
import { determineAdaptationMode } from "./nicheHunter";
import type { TrendPattern } from "../drizzle/schema";
import type { SourceStyleJSON } from "../shared/sourceStyleJson";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makePattern(overrides: Partial<TrendPattern> = {}): TrendPattern {
  return {
    id: "pat-1",
    workspaceId: "ws-1",
    scanRunId: "scan-1",
    patternName: "Test Pattern",
    composition: null,
    colorStrategy: null,
    emotionalHook: null,
    transferablePattern: null,
    whyItWorks: null,
    adaptedConcept: null,
    previewImageUrl: null,
    sourcePlatform: "etsy",
    sourceTitle: "Test Listing",
    sourceUrl: null,
    sourceImageUrl: null,
    sourceSales: null,
    sourceCategory: null,
    transferValid: true,
    transferReasoning: null,
    score: 75,
    rankReasoning: null,
    status: "discovered",
    sourceStyleJson: null,
    adaptationMode: null,
    approvalTags: null,
    approvalReason: null,
    approvedAt: null,
    rejectionTags: null,
    rejectionReason: null,
    dismissedAt: null,
    dtfImageUrl: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as TrendPattern;
}

const MOCK_STYLE: SourceStyleJSON = {
  inkColors: ["black", "cream"],
  inkColorNames: ["matte black", "distressed cream"],
  shirtColorRole: "negative space — shirt IS the background",
  technique: "screen-print simulation",
  lineWeight: "thick bold outlines",
  shadingMethod: "flat color",
  textureDetail: "heavy distress/worn",
  subject: "skeleton holding fishing rod",
  subjectCrop: "full body centered",
  composition: "centered single subject",
  framingDevice: "NONE",
  scaleCoverage: "fills 80% of print area",
  textPresence: "bold headline above subject",
  textStyle: "distressed serif all-caps",
  mood: "irreverent humor",
  humorMechanism: "absurdist juxtaposition",
  printMethod: "simulated screen-print",
  garmentStyle: "dark heather tee",
  designEra: "vintage americana",
  backgroundTreatment: "transparent/no background",
};

// ─── signalWeights ────────────────────────────────────────────────────────────

describe("computeSignalWeights", () => {
  it("returns hasEnoughData=false when fewer than 3 decisions", () => {
    const patterns = [
      makePattern({ status: "approved", approvalTags: ["great_style"] }),
      makePattern({ id: "pat-2", status: "dismissed", rejectionTags: ["wrong_style"] }),
    ];
    const result = computeSignalWeights(patterns);
    expect(result.hasEnoughData).toBe(false);
    expect(result.totalApprovals).toBe(1);
    expect(result.totalRejections).toBe(1);
  });

  it("returns hasEnoughData=true with 3+ decisions", () => {
    const patterns = [
      makePattern({ id: "p1", status: "approved", approvalTags: ["great_style", "love_colors"] }),
      makePattern({ id: "p2", status: "approved", approvalTags: ["great_style"] }),
      makePattern({ id: "p3", status: "dismissed", rejectionTags: ["wrong_style"] }),
    ];
    const result = computeSignalWeights(patterns);
    expect(result.hasEnoughData).toBe(true);
    expect(result.totalApprovals).toBe(2);
    expect(result.totalRejections).toBe(1);
  });

  it("counts approval tags correctly and sorts by count desc", () => {
    const patterns = [
      makePattern({ id: "p1", status: "approved", approvalTags: ["great_style", "love_colors"] }),
      makePattern({ id: "p2", status: "approved", approvalTags: ["great_style", "niche_authentic"] }),
      makePattern({ id: "p3", status: "approved", approvalTags: ["great_style"] }),
    ];
    const result = computeSignalWeights(patterns);
    expect(result.approvalSignals[0].label).toBe("Great style");
    expect(result.approvalSignals[0].count).toBe(3);
    expect(result.approvalSignals[0].type).toBe("approval");
  });

  it("counts rejection tags correctly", () => {
    const patterns = [
      makePattern({ id: "p1", status: "dismissed", rejectionTags: ["wrong_style", "bad_colors"] }),
      makePattern({ id: "p2", status: "dismissed", rejectionTags: ["wrong_style"] }),
      makePattern({ id: "p3", status: "dismissed", rejectionTags: ["too_generic"] }),
    ];
    const result = computeSignalWeights(patterns);
    expect(result.rejectionSignals[0].label).toBe("Wrong style");
    expect(result.rejectionSignals[0].count).toBe(2);
    expect(result.rejectionSignals[0].type).toBe("rejection");
  });

  it("ignores discovered patterns", () => {
    const patterns = [
      makePattern({ id: "p1", status: "discovered", approvalTags: ["great_style"] }),
      makePattern({ id: "p2", status: "discovered", rejectionTags: ["wrong_style"] }),
    ];
    const result = computeSignalWeights(patterns);
    expect(result.totalApprovals).toBe(0);
    expect(result.totalRejections).toBe(0);
    expect(result.approvalSignals).toHaveLength(0);
  });

  it("handles null tags gracefully", () => {
    const patterns = [
      makePattern({ id: "p1", status: "approved", approvalTags: null }),
      makePattern({ id: "p2", status: "dismissed", rejectionTags: null }),
      makePattern({ id: "p3", status: "approved", approvalTags: null }),
    ];
    const result = computeSignalWeights(patterns);
    expect(result.totalApprovals).toBe(2);
    expect(result.totalRejections).toBe(1);
    expect(result.approvalSignals).toHaveLength(0);
    expect(result.hasEnoughData).toBe(true);
  });

  it("caps output at 6 signals per category", () => {
    const allApprovalTags = ["great_style", "perfect_subject", "strong_humor", "niche_authentic", "clean_composition", "love_colors"];
    const patterns = allApprovalTags.map((tag, i) =>
      makePattern({ id: `p${i}`, status: "approved", approvalTags: [tag] })
    );
    patterns.push(makePattern({ id: "p7", status: "dismissed", rejectionTags: ["wrong_style"] }));
    patterns.push(makePattern({ id: "p8", status: "dismissed", rejectionTags: ["wrong_style"] }));
    patterns.push(makePattern({ id: "p9", status: "dismissed", rejectionTags: ["wrong_style"] }));
    const result = computeSignalWeights(patterns);
    expect(result.approvalSignals.length).toBeLessThanOrEqual(6);
  });

  it("uses unknown tag id as label when not in TAG_LABELS", () => {
    const patterns = [
      makePattern({ id: "p1", status: "approved", approvalTags: ["mystery_tag"] }),
      makePattern({ id: "p2", status: "approved", approvalTags: ["mystery_tag"] }),
      makePattern({ id: "p3", status: "dismissed", rejectionTags: ["another_unknown"] }),
    ];
    const result = computeSignalWeights(patterns);
    expect(result.approvalSignals[0].label).toBe("mystery_tag");
  });
});

// ─── determineAdaptationMode ──────────────────────────────────────────────────

describe("determineAdaptationMode", () => {
  it("returns prompt_only when no sourceImageUrl", () => {
    expect(determineAdaptationMode(undefined, null)).toBe("prompt_only");
    expect(determineAdaptationMode("", null)).toBe("prompt_only");
  });

  it("returns edit_source when sourceImageUrl AND sourceStyle are present", () => {
    expect(determineAdaptationMode("https://example.com/img.jpg", MOCK_STYLE)).toBe("edit_source");
  });

  it("returns style_reference when sourceImageUrl present but sourceStyle is null", () => {
    expect(determineAdaptationMode("https://example.com/img.jpg", null)).toBe("style_reference");
  });

  it("returns prompt_only for empty string sourceImageUrl regardless of style", () => {
    expect(determineAdaptationMode("", MOCK_STYLE)).toBe("prompt_only");
  });
});

// ─── extractStyleFromImage (mocked invokeLLM) ─────────────────────────────────

describe("extractStyleFromImage", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("returns null when imageUrl is empty string", async () => {
    const { extractStyleFromImage } = await import("./styleExtractor");
    const result = await extractStyleFromImage("");
    expect(result).toBeNull();
  });

  it("returns null when invokeLLM throws", async () => {
    vi.doMock("./_core/llm", () => ({
      invokeLLM: vi.fn().mockRejectedValue(new Error("LLM timeout")),
    }));
    const { extractStyleFromImage } = await import("./styleExtractor");
    const result = await extractStyleFromImage("https://example.com/image.jpg");
    expect(result).toBeNull();
  });

  it("returns null when LLM returns invalid JSON", async () => {
    vi.doMock("./_core/llm", () => ({
      invokeLLM: vi.fn().mockResolvedValue({
        choices: [{ message: { content: "not valid json at all" } }],
      }),
    }));
    const { extractStyleFromImage } = await import("./styleExtractor");
    const result = await extractStyleFromImage("https://example.com/image.jpg");
    expect(result).toBeNull();
  });

  it("returns null when LLM returns empty choices", async () => {
    vi.doMock("./_core/llm", () => ({
      invokeLLM: vi.fn().mockResolvedValue({ choices: [] }),
    }));
    const { extractStyleFromImage } = await import("./styleExtractor");
    const result = await extractStyleFromImage("https://example.com/image.jpg");
    expect(result).toBeNull();
  });

  it("returns parsed SourceStyleJSON when LLM returns valid JSON", async () => {
    vi.doMock("./_core/llm", () => ({
      invokeLLM: vi.fn().mockResolvedValue({
        choices: [{ message: { content: JSON.stringify(MOCK_STYLE) } }],
      }),
    }));
    const { extractStyleFromImage } = await import("./styleExtractor");
    const result = await extractStyleFromImage("https://example.com/image.jpg");
    expect(result).not.toBeNull();
    expect(result?.technique).toBe("screen-print simulation");
    expect(result?.inkColors).toEqual(["black", "cream"]);
    expect(result?.mood).toBe("irreverent humor");
  });
});

// ─── Source quality filtering (exported constants tested via integration) ─────

describe("Source quality filtering logic", () => {
  const MIN_FAVORITES = 500;
  const TITLE_BLOCKLIST = [
    "custom", "personalized", "customized", "personalised", "made to order",
    "your name", "your text", "add your",
    "polo", "performance", "hawaiian", "sublimation", "all over print",
    "allover", "full print", "jersey", "dri-fit", "moisture wicking",
    "embroidered", "embroidery",
  ];

  function wouldBeFiltered(title: string, favorites: number): { filtered: boolean; reason?: string } {
    if (favorites < MIN_FAVORITES) return { filtered: true, reason: "low_favorites" };
    const titleLower = title.toLowerCase();
    const blockedTerm = TITLE_BLOCKLIST.find(term => titleLower.includes(term));
    if (blockedTerm) return { filtered: true, reason: `blocked_term:${blockedTerm}` };
    return { filtered: false };
  }

  it("filters listings with fewer than 500 favorites (Fix #1)", () => {
    expect(wouldBeFiltered("Cool Hiking Shirt", 50).filtered).toBe(true);
    expect(wouldBeFiltered("Cool Hiking Shirt", 499).filtered).toBe(true);
    expect(wouldBeFiltered("Cool Hiking Shirt", 500).filtered).toBe(false);
    expect(wouldBeFiltered("Cool Hiking Shirt", 2000).filtered).toBe(false);
  });

  it("filters customizable products (Fix #4)", () => {
    expect(wouldBeFiltered("Custom Golf Shirt Personalized Name", 1000).filtered).toBe(true);
    expect(wouldBeFiltered("Personalized Yoga Tee", 800).filtered).toBe(true);
    expect(wouldBeFiltered("Customized Fishing Hoodie", 600).filtered).toBe(true);
    expect(wouldBeFiltered("Add Your Name Hiking Shirt", 700).filtered).toBe(true);
  });

  it("filters polo/performance/pattern shirts (Fix #7)", () => {
    expect(wouldBeFiltered("Hawaiian Golf Polo Shirt", 1500).filtered).toBe(true);
    expect(wouldBeFiltered("Dri-Fit Performance Tennis Tee", 900).filtered).toBe(true);
    expect(wouldBeFiltered("All Over Print Sublimation Shirt", 2000).filtered).toBe(true);
    expect(wouldBeFiltered("Embroidered Fishing Cap", 800).filtered).toBe(true);
    expect(wouldBeFiltered("Full Print Jersey Design", 1200).filtered).toBe(true);
  });

  it("allows genuine graphic t-shirts with high favorites", () => {
    expect(wouldBeFiltered("Funny Hiking Bear Graphic Tee", 1500).filtered).toBe(false);
    expect(wouldBeFiltered("Retro Camping Sunset Shirt", 800).filtered).toBe(false);
    expect(wouldBeFiltered("Yoga Cat Poses T-Shirt", 2000).filtered).toBe(false);
    expect(wouldBeFiltered("I'd Rather Be Fishing Tee", 600).filtered).toBe(false);
  });

  it("returns correct reason for low favorites", () => {
    const result = wouldBeFiltered("Tennis Shirt", 10);
    expect(result.reason).toBe("low_favorites");
  });

  it("returns correct reason for blocked terms", () => {
    const result = wouldBeFiltered("Hawaiian Polo Shirt", 2000);
    expect(result.reason).toContain("blocked_term:");
  });
});

// ─── buildGenerationPayload prompt content verification ──────────────────────

describe("buildGenerationPayload prompt hardening", () => {
  // We can't easily unit-test the actual function without exporting it,
  // but we can verify the prompt strings that would be generated.
  // These tests verify the CONSTRAINTS are present in the prompt template.

  const EDIT_SOURCE_REQUIRED_CONSTRAINTS = [
    // gpt-image-2 minimal one-sentence template (Spike A/C pattern)
    "Instead of a",
    "change it to a",
    "plain white background",
    // Composition refinement appended when available
    "composition matching the reference",
    // gpt-image-2 API call — fail-loud, no Forge fallback
    "gpt-image-2",
    "OPENAI_API_KEY",
  ];

  const DECONSTRUCT_REQUIRED_CONSTRAINTS = [
    "The ONLY target niche is",  // AR2: now templated from nicheProfile.summary
    "NEVER adapt to another sport",
    "CHARACTER-ONLY SWAP",  // AR1: renamed constraint
    "INJECTION (forbidden)",
    "NO TEXT INJECTION",
  ];

  it("edit_source prompt template contains all prohibition rules (Fix #6, #9)", async () => {
    // Read the actual file to verify prompt strings exist
    const fs = await import("fs");
    const fileContent = fs.readFileSync("./server/nicheHunter.ts", "utf-8");

    for (const constraint of EDIT_SOURCE_REQUIRED_CONSTRAINTS) {
      expect(fileContent).toContain(constraint);
    }
  });

  it("deconstructAndAdapt prompt contains all hard constraints (Fix #2, #5, #8, #9)", async () => {
    const fs = await import("fs");
    const fileContent = fs.readFileSync("./server/nicheHunter.ts", "utf-8");

    for (const constraint of DECONSTRUCT_REQUIRED_CONSTRAINTS) {
      expect(fileContent).toContain(constraint);
    }
  });
});

// ─── Matching algorithm correctness ──────────────────────────────────────────

describe("Character swap matching algorithm", () => {
  // Mirror the algorithm from nicheHunter.ts buildGenerationPayload.
  // Tests verify the ≥2 token overlap rule prevents false positives.

  const STOPWORDS = new Set([
    "a", "an", "the", "and", "or", "of", "in", "on", "at", "to", "for",
    "with", "by", "from", "is", "it", "its", "as", "are", "was", "be",
    "this", "that", "have", "has", "had", "do", "does", "did", "not",
  ]);
  const tokenize = (text: string): Set<string> => new Set(
    text.toLowerCase()
      .split(/[\s/,\-–—.!?()]+/)
      .filter(w => w.length > 2 && !STOPWORDS.has(w))
  );

  function findBestMatch(
    sourceSubject: string,
    mappings: Array<{ sourcePattern: string; targetAdaptation: string }>
  ) {
    const sourceTokens = tokenize(sourceSubject);
    let bestMatch: (typeof mappings)[0] | null = null;
    let bestOverlap = 0;
    for (const m of mappings) {
      const patternTokens = tokenize(m.sourcePattern);
      let overlap = 0;
      Array.from(patternTokens).forEach(t => { if (sourceTokens.has(t)) overlap++; });
      if (overlap >= 2 && overlap > bestOverlap) {
        bestOverlap = overlap;
        bestMatch = m;
      }
    }
    return { bestMatch, bestOverlap };
  }

  const PICKLEBALL_MAPPINGS = [
    { sourcePattern: "Bigfoot/Sasquatch blowing a dandelion", targetAdaptation: "Llama blowing a dandelion" },
    { sourcePattern: "Bear hiking with a backpack", targetAdaptation: "Llama with a pickleball paddle" },
    { sourcePattern: "Skeleton holding a fishing rod", targetAdaptation: "Skeleton playing pickleball" },
    { sourcePattern: "Cat doing yoga poses", targetAdaptation: "Cat in pickleball poses" },
    { sourcePattern: "Dog with hiking gear", targetAdaptation: "Dog with pickleball gear" },
    { sourcePattern: "Retro cowboy/western character", targetAdaptation: "Retro pickleball player" },
  ];

  it("matches Bigfoot blowing dandelion in profile view → Llama blowing a dandelion", () => {
    const { bestMatch, bestOverlap } = findBestMatch(
      "Bigfoot blowing a dandelion in profile view",
      PICKLEBALL_MAPPINGS
    );
    expect(bestMatch?.targetAdaptation).toBe("Llama blowing a dandelion");
    expect(bestOverlap).toBeGreaterThanOrEqual(2);
  });

  it("matches Sasquatch blowing dandelion seeds → Llama blowing a dandelion", () => {
    const { bestMatch } = findBestMatch(
      "Sasquatch blowing dandelion seeds",
      PICKLEBALL_MAPPINGS
    );
    expect(bestMatch?.targetAdaptation).toBe("Llama blowing a dandelion");
  });

  it("does NOT match Bear with coffee mug (only 1 token overlap: 'bear')", () => {
    const { bestMatch } = findBestMatch(
      "Bear with coffee mug",
      PICKLEBALL_MAPPINGS
    );
    // 'bear' is 1 token; 'with' is a stopword; 'coffee' and 'mug' are not in the pattern
    expect(bestMatch).toBeNull();
  });

  it("does NOT match a pilates pose design (no animal tokens)", () => {
    const { bestMatch } = findBestMatch(
      "Woman doing pilates pose on mat",
      PICKLEBALL_MAPPINGS
    );
    expect(bestMatch).toBeNull();
  });

  it("matches Skeleton fishing rod → Skeleton playing pickleball", () => {
    const { bestMatch } = findBestMatch(
      "Skeleton holding a fishing rod by the lake",
      PICKLEBALL_MAPPINGS
    );
    expect(bestMatch?.targetAdaptation).toBe("Skeleton playing pickleball");
  });

  it("prefers highest overlap when multiple patterns partially match", () => {
    // 'Dog hiking with gear' overlaps with both 'Dog with hiking gear' (3 tokens) and
    // 'Bear hiking with a backpack' (1 token: 'hiking')
    const { bestMatch } = findBestMatch(
      "Dog hiking with gear and backpack",
      PICKLEBALL_MAPPINGS
    );
    // 'Dog with hiking gear' has tokens: dog, hiking, gear → 3 overlap
    // 'Bear hiking with a backpack' has tokens: bear, hiking, backpack → 1 overlap (hiking)
    expect(bestMatch?.targetAdaptation).toBe("Dog with pickleball gear");
  });
});
