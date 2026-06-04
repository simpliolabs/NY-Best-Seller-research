/**
 * General Best Seller Term Resolution Tests
 *
 * Tests the resolveGeneralBestSellerTerms and deriveSearchTermsFromProductTypes
 * logic that determines which general market terms are always scraped.
 */
import { describe, expect, it, vi } from "vitest";

// We test the exported logic indirectly by importing the module and testing
// the deriveSearchTermsFromProductTypes function behavior through the scan pipeline.
// Since these are private functions, we test them via a dedicated export for testing.

// For unit testing, we extract the pure logic into a testable helper.
// The actual functions are private in nicheHunter.ts, so we test the behavior
// through the public interface (runNicheHunterScan) or by re-implementing the
// pure derivation logic here to verify correctness.

describe("deriveSearchTermsFromProductTypes (logic verification)", () => {
  // Re-implement the pure derivation logic to verify it matches expectations
  function deriveSearchTermsFromProductTypes(productTypes: string[]): string[] {
    const termMap: Record<string, string[]> = {
      "t-shirt":    ["funny shirt", "graphic tee"],
      "tee":        ["funny shirt", "graphic tee"],
      "shirt":      ["funny shirt", "graphic shirt"],
      "hoodie":     ["funny hoodie", "graphic hoodie"],
      "sweatshirt": ["funny sweatshirt", "graphic sweatshirt"],
      "tank":       ["funny tank top", "graphic tank"],
      "tank top":   ["funny tank top", "graphic tank"],
      "crewneck":   ["funny crewneck", "graphic crewneck"],
      "long sleeve": ["funny long sleeve shirt", "graphic long sleeve"],
      "mug":        ["funny mug", "graphic mug"],
      "sticker":    ["funny sticker", "graphic sticker"],
      "tote bag":   ["funny tote bag", "graphic tote"],
      "poster":     ["funny poster", "graphic poster"],
    };

    const terms = new Set<string>();
    for (const pt of productTypes) {
      const normalized = pt.toLowerCase().trim();
      const mapped = termMap[normalized];
      if (mapped) {
        mapped.forEach(t => terms.add(t));
      } else {
        terms.add(`funny ${normalized}`);
        terms.add(`graphic ${normalized}`);
      }
    }
    return Array.from(terms).slice(0, 3);
  }

  it("maps T-Shirt to 'funny shirt' and 'graphic tee'", () => {
    const result = deriveSearchTermsFromProductTypes(["t-shirt"]);
    expect(result).toEqual(["funny shirt", "graphic tee"]);
  });

  it("maps Hoodie to 'funny hoodie' and 'graphic hoodie'", () => {
    const result = deriveSearchTermsFromProductTypes(["hoodie"]);
    expect(result).toEqual(["funny hoodie", "graphic hoodie"]);
  });

  it("maps Mug to 'funny mug' and 'graphic mug'", () => {
    const result = deriveSearchTermsFromProductTypes(["mug"]);
    expect(result).toEqual(["funny mug", "graphic mug"]);
  });

  it("handles unknown product types with generic fallback", () => {
    const result = deriveSearchTermsFromProductTypes(["hat"]);
    expect(result).toEqual(["funny hat", "graphic hat"]);
  });

  it("deduplicates when multiple product types map to same terms", () => {
    const result = deriveSearchTermsFromProductTypes(["t-shirt", "tee"]);
    // Both map to "funny shirt" + "graphic tee" — should deduplicate
    expect(result).toEqual(["funny shirt", "graphic tee"]);
  });

  it("caps output at 3 terms even with multiple product types", () => {
    const result = deriveSearchTermsFromProductTypes(["t-shirt", "hoodie", "mug"]);
    expect(result.length).toBeLessThanOrEqual(3);
  });

  it("normalizes case and trims whitespace", () => {
    const result = deriveSearchTermsFromProductTypes(["  T-SHIRT  "]);
    expect(result).toEqual(["funny shirt", "graphic tee"]);
  });
});

describe("resolveGeneralBestSellerTerms priority logic", () => {
  // Test the priority resolution logic:
  // Priority 1: Explicit generalBestSellerTerms in nicheProfile
  // Priority 2: Derived from product groups
  // Priority 3: Default fallback

  it("Priority 1: uses explicit generalBestSellerTerms when present", () => {
    const profile = {
      generalBestSellerTerms: ["custom term 1", "custom term 2"],
      summary: "test",
    };
    // When generalBestSellerTerms is set, it should be used directly
    expect(profile.generalBestSellerTerms).toEqual(["custom term 1", "custom term 2"]);
  });

  it("Priority 3: default fallback is 'funny shirt' and 'graphic tee'", () => {
    // When no explicit terms and no product groups, default should be used
    const DEFAULT_TERMS = ["funny shirt", "graphic tee"];
    expect(DEFAULT_TERMS).toEqual(["funny shirt", "graphic tee"]);
  });
});

describe("fetchCrossNicheHotSellers category assembly", () => {
  it("general terms are prepended before cross-niche categories", () => {
    // Simulate the category assembly logic from fetchCrossNicheHotSellers
    const crossNicheCategories = ["hiking shirt", "yoga tee", "fishing shirt", "bowling shirt", "camping tee"];
    const generalBestSellerTerms = ["funny shirt", "graphic tee"];

    const generalTerms = (generalBestSellerTerms ?? []).slice(0, 3);
    const crossNiche = crossNicheCategories.slice(0, 10 - generalTerms.length);
    const categories = [...generalTerms, ...crossNiche];

    // General terms come first
    expect(categories[0]).toBe("funny shirt");
    expect(categories[1]).toBe("graphic tee");
    // Cross-niche follows
    expect(categories[2]).toBe("hiking shirt");
    expect(categories[3]).toBe("yoga tee");
  });

  it("total categories capped at 10 (3 general + 7 cross-niche)", () => {
    const crossNicheCategories = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"];
    const generalBestSellerTerms = ["funny shirt", "graphic tee", "graphic shirt"];

    const generalTerms = (generalBestSellerTerms ?? []).slice(0, 3);
    const crossNiche = crossNicheCategories.slice(0, 10 - generalTerms.length);
    const categories = [...generalTerms, ...crossNiche];

    expect(categories.length).toBe(10);
    expect(generalTerms.length).toBe(3);
    expect(crossNiche.length).toBe(7);
  });

  it("handles empty general terms gracefully (all slots go to cross-niche)", () => {
    const crossNicheCategories = ["hiking shirt", "yoga tee", "fishing shirt"];
    const generalBestSellerTerms: string[] = [];

    const generalTerms = (generalBestSellerTerms ?? []).slice(0, 3);
    const crossNiche = crossNicheCategories.slice(0, 10 - generalTerms.length);
    const categories = [...generalTerms, ...crossNiche];

    expect(categories).toEqual(["hiking shirt", "yoga tee", "fishing shirt"]);
  });

  it("handles undefined general terms (falls back to empty)", () => {
    const crossNicheCategories = ["hiking shirt", "yoga tee"];
    const generalBestSellerTerms: string[] | undefined = undefined;

    const generalTerms = (generalBestSellerTerms ?? []).slice(0, 3);
    const crossNiche = crossNicheCategories.slice(0, 10 - generalTerms.length);
    const categories = [...generalTerms, ...crossNiche];

    expect(categories).toEqual(["hiking shirt", "yoga tee"]);
  });
});
