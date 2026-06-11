/**
 * warpDesignOntoFabric — the fabric warp+shade pass (PO-approved 2026-06-11, local-contrast).
 * Verifies: strength 0 = flat composite; strength>0 shades the design by the fabric's FOLD detail
 * (a dark crease darkens the print over it). Uses a fold-band fabric, NOT a linear gradient — the
 * local-contrast high-pass intentionally ignores broad gradients and follows local folds.
 */
import { describe, it, expect } from "vitest";
import sharp from "sharp";
import { warpDesignOntoFabric } from "./mockupCompositor";

/** 100x100 garment: uniform 180, with a dark horizontal fold band (value 90) at rows 44-56. */
async function foldBandShirt(): Promise<Buffer> {
  const w = 100, h = 100, buf = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = y >= 44 && y <= 56 ? 90 : 180;
      const i = (y * w + x) * 3;
      buf[i] = buf[i + 1] = buf[i + 2] = v;
    }
  return sharp(buf, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}

/** A solid opaque colour square as a transparent-PNG "design". */
async function solidDesign(w: number, h: number, r: number, g: number, b: number): Promise<Buffer> {
  return sharp({ create: { width: w, height: h, channels: 4, background: { r, g, b, alpha: 255 } } }).png().toBuffer();
}

async function px(buf: Buffer, x: number, y: number): Promise<[number, number, number]> {
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * info.channels;
  return [data[i], data[i + 1], data[i + 2]];
}

describe("warpDesignOntoFabric (local-contrast)", () => {
  it("strength 0 = flat paste — the design lands at its own colour", async () => {
    // design 40x40 at (30,30) -> spans rows 30-69; sample a row ABOVE the fold band
    const out = await warpDesignOntoFabric(await foldBandShirt(), await solidDesign(40, 40, 200, 40, 40), 30, 30, 0);
    const [r, g, b] = await px(out, 50, 35);
    expect(r).toBeGreaterThan(150);
    expect(g).toBeLessThan(90);
    expect(b).toBeLessThan(90);
  });

  it("strength>0 darkens the print OVER a fold crease vs away from it", async () => {
    const out = await warpDesignOntoFabric(await foldBandShirt(), await solidDesign(40, 40, 200, 40, 40), 30, 30, 0.5);
    const overFold = await px(out, 50, 50); // design pixel over the dark band (rows 44-56)
    const awayFold = await px(out, 50, 34); // design pixel above the band
    expect(overFold[0]).toBeLessThan(awayFold[0]); // red darkened in the crease
  });

  it("preserves the garment dimensions", async () => {
    const out = await warpDesignOntoFabric(await foldBandShirt(), await solidDesign(40, 40, 200, 40, 40), 30, 30, 0.35);
    const m = await sharp(out).metadata();
    expect(m.width).toBe(100);
    expect(m.height).toBe(100);
  });
});
