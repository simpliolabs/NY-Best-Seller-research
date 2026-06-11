/**
 * warpDesignOntoFabric — the fabric warp+shade pass (PO-approved 2026-06-11).
 * Verifies: strength 0 = flat composite; strength>0 shades the design by the fabric's folds.
 */
import { describe, it, expect } from "vitest";
import sharp from "sharp";
import { warpDesignOntoFabric } from "./mockupCompositor";

/** A 100x100 garment with a horizontal luminance gradient (dark left -> light right) = a fold. */
async function gradientShirt(): Promise<Buffer> {
  const w = 100, h = 100, buf = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = Math.round(60 + (180 * x) / (w - 1));
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

describe("warpDesignOntoFabric", () => {
  it("strength 0 = flat paste — the design lands at its own colour", async () => {
    const out = await warpDesignOntoFabric(await gradientShirt(), await solidDesign(40, 40, 200, 40, 40), 30, 30, 0);
    const [r, g, b] = await px(out, 50, 50); // centre of the placed 40x40 design
    expect(r).toBeGreaterThan(150);
    expect(g).toBeLessThan(90);
    expect(b).toBeLessThan(90);
  });

  it("strength>0 shades the design by the fabric (dark fold side darker than the light side)", async () => {
    const out = await warpDesignOntoFabric(await gradientShirt(), await solidDesign(40, 40, 200, 40, 40), 30, 30, 0.5);
    const left = await px(out, 33, 50); // over the dark (fold) side
    const right = await px(out, 67, 50); // over the light (ridge) side
    expect(left[0]).toBeLessThan(right[0]); // red darkened in the fold, lifted on the ridge
  });

  it("preserves the garment dimensions", async () => {
    const out = await warpDesignOntoFabric(await gradientShirt(), await solidDesign(40, 40, 200, 40, 40), 30, 30, 0.35);
    const m = await sharp(out).metadata();
    expect(m.width).toBe(100);
    expect(m.height).toBe(100);
  });
});
