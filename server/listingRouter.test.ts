/**
 * SKU abbreviation helpers — locks the PO's variant-SKU format (PO 2026-06-11).
 * SKU = BASE(group)-SIZE-COLOR(abbr)-DESIGN(abbr), e.g. 1717-M-ESP-DNK.
 */
import { describe, it, expect } from "vitest";
import { abbrev3, skuBase } from "./listingRouter";

describe("abbrev3 — 3-char color/design abbreviation", () => {
  it("matches the PO's examples", () => {
    expect(abbrev3("Espresso")).toBe("ESP");
    expect(abbrev3("Dink")).toBe("DNK");
  });
  it("keeps the first letter then consonants", () => {
    expect(abbrev3("Black")).toBe("BLC");
    expect(abbrev3("White")).toBe("WHT");
  });
  it("handles short / messy input without throwing", () => {
    expect(abbrev3("M")).toBe("M");
    expect(abbrev3("")).toBe("XXX");
    expect(abbrev3("Sport Grey").length).toBe(3);
  });
});

describe("skuBase — product-group base code", () => {
  it("keeps alphanumerics, uppercased", () => {
    expect(skuBase("1717")).toBe("1717");
    expect(skuBase("Premium Tee")).toBe("PREMIUMTEE");
    expect(skuBase("")).toBe("PRD");
  });
});
