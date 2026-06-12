/**
 * chromakeyFromCorners — magenta despill (PO 2026-06-11).
 * The binary flood-fill keys the magenta background but, before the despill pass, left anti-aliased
 * art edges (fine net grids, thin linework) opaque with magenta-contaminated RGB = a pink fringe.
 * These tests use an ANTI-ALIASED blue<->magenta blend edge — the exact case the old flat-block
 * synthetic test could never catch.
 */
import { describe, it, expect } from "vitest";
import sharp from "sharp";
import { chromakeyFromCorners } from "./chromakey";

/** 50x20: muted-magenta key bg, a true-blue bar in the middle, and a 1px anti-aliased blue<->magenta
 *  blend column on each side of the bar (the fringe the keyer used to leave magenta). */
async function antialiasedEdge(): Promise<Buffer> {
  const w = 50, h = 20, buf = Buffer.alloc(w * h * 4);
  const set = (x: number, y: number, r: number, g: number, b: number) => {
    const i = (y * w + x) * 4; buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = 255;
  };
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (x >= 22 && x <= 27) set(x, y, 50, 90, 180);        // true blue bar
      else if (x === 21 || x === 28) set(x, y, 130, 85, 165); // anti-aliased blend = magenta-ish fringe
      else set(x, y, 210, 80, 150);                           // muted magenta render bg (the key)
    }
  return sharp(buf, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
}

/** 40x40: magenta everywhere, with a SOLID 2px blue ring enclosing an inner magenta region — a "net
 *  mesh hole" the border-seeded flood-fill cannot reach. The inner magenta must still get keyed. */
async function enclosedHole(): Promise<Buffer> {
  const w = 40, h = 40, buf = Buffer.alloc(w * h * 4);
  const set = (x: number, y: number, r: number, g: number, b: number) => {
    const i = (y * w + x) * 4; buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = 255;
  };
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const inSquare = x >= 12 && x <= 27 && y >= 12 && y <= 27;
      const onRing = inSquare && (x <= 13 || x >= 26 || y <= 13 || y >= 26);
      if (onRing) set(x, y, 50, 90, 180);   // continuous blue ring
      else set(x, y, 210, 80, 150);          // magenta: both the enclosed interior and the outer bg
    }
  return sharp(buf, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
}

async function px(buf: Buffer, x: number, y: number) {
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * info.channels;
  return { r: data[i], g: data[i + 1], b: data[i + 2], a: data[i + 3] };
}

describe("chromakeyFromCorners — magenta despill", () => {
  it("keys the magenta background to transparent", async () => {
    const out = await chromakeyFromCorners(await antialiasedEdge());
    expect((await px(out, 0, 0)).a).toBe(0);
    expect((await px(out, 10, 10)).a).toBe(0);
  });

  it("preserves the true blue bar (colour + opacity)", async () => {
    const out = await chromakeyFromCorners(await antialiasedEdge());
    const blue = await px(out, 25, 10);
    expect(blue.a).toBe(255);
    expect(blue.b).toBeGreaterThan(blue.r); // still reads blue, untouched by despill
  });

  it("despills the fringe — any surviving edge pixel is NOT magenta", async () => {
    const out = await chromakeyFromCorners(await antialiasedEdge());
    const edge = await px(out, 21, 10); // the blend column, adjacent to the keyed bg
    if (edge.a > 0) {
      // before the fix this stayed (130,85,165): R and B far above G = bright magenta.
      expect(edge.r).toBeLessThanOrEqual(edge.g + 16);
      expect(edge.b).toBeLessThanOrEqual(edge.g + 16);
    }
  });

  it("keys magenta ENCLOSED by the art (net mesh holes), not just the border", async () => {
    const out = await chromakeyFromCorners(await enclosedHole());
    expect((await px(out, 0, 0)).a).toBe(0);   // outer background keyed
    expect((await px(out, 20, 20)).a).toBe(0); // enclosed magenta keyed — the fix
    const ring = await px(out, 12, 20);
    expect(ring.a).toBe(255);                  // blue ring preserved
    expect(ring.b).toBeGreaterThan(ring.r);
  });
});
