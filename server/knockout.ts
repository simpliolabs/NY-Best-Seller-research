/**
 * Color knockout (PO 2026-06-17, print-shop plan CP2). Delete a color from the artwork so the
 * GARMENT shows through — e.g. a white-line skull on a black tee: knock out the black so the shirt
 * becomes the black. This is the Photoshop "Select Color Range → delete" operation, done
 * deterministically in raw pixels.
 *
 * The craft (from a 30-yr screen + Photoshop production review):
 *  - FLOOD mode (default): edge-connected flood from the borders, so we remove the shirt-colored
 *    BACKGROUND only — never the design's OWN same-color detail (the skull's black eyes survive).
 *  - SMOOTHSTEP alpha ramp across [tol, tol+fuzz]: no binary cut. A hard cut leaves the jagged
 *    "white-square" halo; the ramp feathers the anti-aliased edge.
 *  - DEFRINGE: a knocked-out edge keeps the old shirt-color in its semi-transparent pixels' RGB,
 *    which DTF prints as a milky ring. We bleed the design's edge color into those pixels so the
 *    semi-transparent ink is the design color, not the shirt color.
 *  - FRINGE CLEANUP: zero the faintest residual edge pixels so no ghost ring survives on a dark shirt.
 *
 * GLOBAL mode is available but dangerous (deletes in-design same-color detail) — caller opt-in only.
 */
import sharp from "sharp";

export interface RGB { r: number; g: number; b: number; }

export function hexToRgb(hex: string): RGB | null {
  const m = hex.trim().replace(/^#/, "");
  if (m.length !== 6) return null;
  const r = parseInt(m.slice(0, 2), 16), g = parseInt(m.slice(2, 4), 16), b = parseInt(m.slice(4, 6), 16);
  if ([r, g, b].some(Number.isNaN)) return null;
  return { r, g, b };
}

/** Weighted RGB distance (eye is most sensitive to green) — a cheap perceptual approximation. 0..~520. */
function colorDist(r: number, g: number, b: number, t: RGB): number {
  const dr = r - t.r, dg = g - t.g, db = b - t.b;
  return Math.sqrt(2 * dr * dr + 4 * dg * dg + 3 * db * db);
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

export async function knockoutColors(
  srcBuf: Buffer,
  opts: { targets: RGB[]; tolerance?: number; fuzz?: number; mode?: "flood" | "global"; defringe?: boolean },
): Promise<Buffer> {
  const tol = opts.tolerance ?? 60;
  const fuzz = opts.fuzz ?? 45;
  const mode = opts.mode ?? "flood";
  const doDefringe = opts.defringe ?? true;

  const { data, info } = await sharp(srcBuf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height, N = W * H;
  const out = Buffer.from(data);

  // alpha MULTIPLIER for a pixel: 0 = full knockout, 1 = keep, between = feather (closest target wins).
  const matchFactor = (idx: number): number => {
    const r = data[idx], g = data[idx + 1], b = data[idx + 2];
    let best = 1;
    for (const t of opts.targets) {
      const f = smoothstep(tol, tol + fuzz, colorDist(r, g, b, t));
      if (f < best) best = f;
    }
    return best;
  };

  if (mode === "global") {
    for (let i = 0; i < N; i++) {
      const idx = i * 4;
      out[idx + 3] = Math.round(out[idx + 3] * matchFactor(idx));
    }
  } else {
    // FLOOD: only knock background-connected matched pixels, from the border inward.
    const visited = new Uint8Array(N);
    const queue: number[] = [];
    const consider = (px: number) => {
      if (visited[px]) return;
      if (matchFactor(px * 4) < 1) { visited[px] = 1; queue.push(px); } // matched or in feather band
    };
    for (let x = 0; x < W; x++) { consider(x); consider((H - 1) * W + x); }
    for (let y = 0; y < H; y++) { consider(y * W); consider(y * W + W - 1); }
    while (queue.length) {
      const px = queue.pop()!;
      const idx = px * 4;
      out[idx + 3] = Math.round(out[idx + 3] * matchFactor(idx));
      const x = px % W, y = (px / W) | 0;
      if (x > 0) consider(px - 1);
      if (x < W - 1) consider(px + 1);
      if (y > 0) consider(px - W);
      if (y < H - 1) consider(px + W);
    }
  }

  if (doDefringe) {
    // DEFRINGE: bleed the design's edge RGB into semi-transparent edge pixels (kills the milky-ring
    // color). A few passes propagate the design color outward into the feather band.
    for (let pass = 0; pass < 3; pass++) {
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const px = y * W + x, idx = px * 4;
          const a = out[idx + 3];
          if (a >= 250 || a === 0) continue; // only the semi-transparent fringe
          // copy RGB from the most-opaque 4-neighbor
          let bestA = a, bx = -1;
          const nb = [px - 1, px + 1, px - W, px + W];
          const valid = [x > 0, x < W - 1, y > 0, y < H - 1];
          for (let k = 0; k < 4; k++) {
            if (!valid[k]) continue;
            const na = out[nb[k] * 4 + 3];
            if (na > bestA) { bestA = na; bx = nb[k]; }
          }
          if (bx >= 0) { out[idx] = out[bx * 4]; out[idx + 1] = out[bx * 4 + 1]; out[idx + 2] = out[bx * 4 + 2]; }
        }
      }
    }
    // FRINGE CLEANUP: zero the faintest residual edge pixels adjacent to full transparency.
    const toZero: number[] = [];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const px = y * W + x, a = out[px * 4 + 3];
        if (a === 0 || a >= 120) continue;
        const nb = [x > 0 && px - 1, x < W - 1 && px + 1, y > 0 && px - W, y < H - 1 && px + W].filter((v) => v !== false) as number[];
        if (nb.some((n) => out[n * 4 + 3] === 0)) toZero.push(px);
      }
    }
    for (const px of toZero) out[px * 4 + 3] = 0;
  }

  return sharp(out, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer();
}
