/**
 * normalizeShopDomain — the guard that stops an attacker-controlled `shop`/`storeDomain` from
 * becoming the host of the OAuth/token-exchange URL (client_secret exfiltration + SSRF).
 * PO-flagged 2026-06-11.
 */
import { describe, it, expect } from "vitest";
import { normalizeShopDomain } from "./shopifyOAuth";

describe("normalizeShopDomain", () => {
  it("accepts a real myshopify domain", () => {
    expect(normalizeShopDomain("my-store.myshopify.com")).toBe("my-store.myshopify.com");
  });

  it("normalises scheme, casing, trailing path/slash", () => {
    expect(normalizeShopDomain("https://My-Store.myshopify.com/")).toBe("my-store.myshopify.com");
    expect(normalizeShopDomain("  http://shop123.myshopify.com  ")).toBe("shop123.myshopify.com");
    // a path appended after the host is stripped (path-injection attempt neutralised)
    expect(normalizeShopDomain("shop.myshopify.com/../evil")).toBe("shop.myshopify.com");
  });

  it("REJECTS attacker-controlled / non-myshopify hosts", () => {
    expect(normalizeShopDomain("evil.com")).toBeNull();
    expect(normalizeShopDomain("store.myshopify.com.evil.com")).toBeNull(); // suffix spoof
    expect(normalizeShopDomain("evil.com/store.myshopify.com")).toBeNull();  // path spoof
    expect(normalizeShopDomain("a.b.myshopify.com")).toBeNull();             // multi-label
    expect(normalizeShopDomain("evil#.myshopify.com")).toBeNull();           // bad char
    expect(normalizeShopDomain("169.254.169.254")).toBeNull();               // SSRF metadata IP
    expect(normalizeShopDomain("localhost")).toBeNull();
  });

  it("REJECTS empty / missing input", () => {
    expect(normalizeShopDomain("")).toBeNull();
    expect(normalizeShopDomain(undefined)).toBeNull();
    expect(normalizeShopDomain(null)).toBeNull();
  });
});
