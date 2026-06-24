/**
 * Halftone / print-file export (PO 2026-06-17, feature B).
 *
 * Two outputs for a design version:
 *   1. prepareFullTonePrintFile — the design as-is at print resolution (300 DPI), transparent PNG.
 *      This is what DTF/DTG presses actually print (garment-independent, full continuous tone).
 *   2. generateHalftoneSeparation — a single-ink AM halftone screen (circular dots whose radius
 *      scales with local darkness). For screen-print separations / the halftone aesthetic. Black is
 *      the default ink.
 *
 * Custom raw-pixel (sharp), no fal/AI: print separations need deterministic, registered dots at a
 * known LPI — an AI model gives an interpretation, not a real screen. Pure functions, unit-testable.
 *
 * v1 scope: black-first single-ink separations, axis-aligned dot grid, no auto white-underbase, no
 * multi-ink registration. The dot grid is axis-aligned (a screen ANGLE to reduce moiré is a labeled
 * future refinement). Outputs are PROOFS to verify on a test print before relying on them.
 */
import sharp from "sharp";

export type InkName = "black" | "white" | "navy" | "red" | "forest" | "maroon" | "gold";

interface RGB { r: number; g: number; b: number; }

/** Print-ink swatches. Black is the default / first option. */
export const INK_COLORS: Record<InkName, RGB> = {
  black: { r: 17, g: 17, b: 17 },
  white: { r: 245, g: 245, b: 245 },
  navy: { r: 28, g: 42, b: 84 },
  red: { r: 178, g: 34, b: 38 },
  forest: { r: 28, g: 74, b: 50 },
  maroon: { r: 102, g: 28, b: 40 },
  gold: { r: 198, g: 158, b: 60 },
};

const DPI = 300;

/** Print canvas dimensions in pixels for a given inch size at 300 DPI. */
export function printPx(widthIn: number, heightIn: number): { widthPx: number; heightPx: number } {
  return { widthPx: Math.round(widthIn * DPI), heightPx: Math.round(heightIn * DPI) };
}

/**
 * Resize a design to the print canvas (contain-fit, transparent margins) and stamp 300 DPI metadata.
 * The design is NOT recoloured or bg-removed here — it's the version the user selected, as-is. If the
 * selected version still has a background, that prints too (the user removes it explicitly upstream).
 */
export async function prepareFullTonePrintFile(
  srcBuf: Buffer,
  widthIn: number,
  heightIn: number,
): Promise<Buffer> {
  const { widthPx, heightPx } = printPx(widthIn, heightIn);
  // STRIP THE WHITE CANVAS (PO 2026-06-17 QA 3.1): for DTF you never want a printed white box.
  // removeBackground is deterministic + SAFE: transparent → unchanged; near-white edge → flood-fill
  // to transparent (preserves interior whites like text); colored/scene → returned VERBATIM (the
  // raccoon's night scene is kept — it's not white). So a mascot-on-white exports as a clean cutout
  // while an intentional scene prints as drawn. The user still removes a colored/scene bg explicitly.
  let cleaned = srcBuf;
  try {
    const { removeBackground } = await import("./mockupCompositor");
    cleaned = await removeBackground(srcBuf);
  } catch (err) {
    console.warn("[Print] white-bg removal failed, exporting as-is:", err);
  }
  return sharp(cleaned)
    .ensureAlpha()
    .resize(widthPx, heightPx, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .withMetadata({ density: DPI })
    .png()
    .toBuffer();
}

/**
 * Single-ink AM halftone separation. Continuous tone → a grid of solid circular dots whose radius
 * scales with each cell's darkness (darker = bigger dot). Output is transparent except the inked dots.
 *
 * - Transparent source pixels contribute NO dot (so the design's silhouette is preserved — we don't
 *   halftone the empty canvas).
 * - cellSize derives from LPI: cell = 300 / lpi px (e.g. 45 LPI → ~7px cells at 300 DPI).
 * - Memory: one widthPx*heightPx*4 input raw + one output raw. At 3600x4800 ≈ 69MB each. Callers
 *   process inks SEQUENTIALLY to stay clear of the Coolify OOM history.
 */
export async function generateHalftoneSeparation(
  srcBuf: Buffer,
  opts: { inkColor: InkName; lpi: number; widthIn: number; heightIn: number },
): Promise<Buffer> {
  const ink = INK_COLORS[opts.inkColor];
  const { widthPx, heightPx } = printPx(opts.widthIn, opts.heightIn);

  // Rasterize the design onto the print canvas first (contain-fit, transparent margins).
  const { data, info } = await sharp(srcBuf)
    .ensureAlpha()
    .resize(widthPx, heightPx, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height;

  const cell = Math.max(2, Math.round(DPI / opts.lpi)); // px per halftone cell
  const Rmax = cell / 2;

  const out = Buffer.alloc(W * H * 4); // all-transparent RGBA

  for (let cy = 0; cy < H; cy += cell) {
    for (let cx = 0; cx < W; cx += cell) {
      // Mean luminance of OPAQUE pixels in this cell. Transparent pixels are ignored so the
      // design's edges stay clean and the empty canvas gets no dots.
      let lumSum = 0, opaque = 0;
      const yEnd = Math.min(cy + cell, H), xEnd = Math.min(cx + cell, W);
      for (let y = cy; y < yEnd; y++) {
        for (let x = cx; x < xEnd; x++) {
          const i = (y * W + x) * 4;
          if (data[i + 3] < 128) continue; // transparent → not part of the design
          lumSum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
          opaque++;
        }
      }
      if (opaque === 0) continue; // cell is fully transparent → no dot

      // Darkness 0..1 (light=small dot, dark=full dot). Weighted by how much of the cell is opaque
      // so a half-covered edge cell yields a proportionally smaller dot (anti-alias the silhouette).
      const coverage = opaque / (cell * cell);
      const darkness = (1 - (lumSum / opaque) / 255) * coverage;
      if (darkness <= 0.001) continue;

      const r = Rmax * Math.sqrt(darkness); // area ∝ darkness
      const ccx = cx + cell / 2, ccy = cy + cell / 2;
      const r2 = r * r;
      const y0 = Math.max(0, Math.floor(ccy - r)), y1 = Math.min(H - 1, Math.ceil(ccy + r));
      const x0 = Math.max(0, Math.floor(ccx - r)), x1 = Math.min(W - 1, Math.ceil(ccx + r));
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const dx = x - ccx, dy = y - ccy;
          if (dx * dx + dy * dy > r2) continue;
          const o = (y * W + x) * 4;
          out[o] = ink.r; out[o + 1] = ink.g; out[o + 2] = ink.b; out[o + 3] = 255;
        }
      }
    }
  }

  return sharp(out, { raw: { width: W, height: H, channels: 4 } })
    .withMetadata({ density: DPI })
    .png()
    .toBuffer();
}
