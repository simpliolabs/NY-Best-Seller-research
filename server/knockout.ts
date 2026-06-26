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

/**
 * Sample the design's BORDER colour + how uniform it is. A uniform border = a flat background colour
 * (white canvas, solid colour) we can safely remove. A non-uniform border = a full scene (the raccoon
 * night street), where there's no "empty" area to cut — that's the opacity-blend case, not removal.
 */
export async function sampleBorderColor(srcBuf: Buffer): Promise<{ color: RGB; uniform: boolean; variance: number }> {
  const { data, info } = await sharp(srcBuf).ensureAlpha().resize(64, 64, { fit: "fill" }).raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height;
  const px: number[] = [];
  let rs = 0, gs = 0, bs = 0, n = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (x > 1 && x < W - 2 && y > 1 && y < H - 2) continue; // border ring only
      const i = (y * W + x) * 4;
      if (data[i + 3] < 40) continue; // skip already-transparent
      rs += data[i]; gs += data[i + 1]; bs += data[i + 2]; n++;
      px.push(data[i], data[i + 1], data[i + 2]);
    }
  }
  if (n === 0) return { color: { r: 255, g: 255, b: 255 }, uniform: false, variance: 1e9 };
  const color = { r: rs / n, g: gs / n, b: bs / n };
  let varSum = 0;
  for (let k = 0; k < px.length; k += 3) {
    const dr = px[k] - color.r, dg = px[k + 1] - color.g, db = px[k + 2] - color.b;
    varSum += dr * dr + dg * dg + db * db;
  }
  const variance = varSum / (px.length / 3);
  return { color: { r: Math.round(color.r), g: Math.round(color.g), b: Math.round(color.b) }, uniform: variance < 1800, variance };
}

/**
 * Canva-style background removal (PO 2026-06-17): find the big UNIFORM background region and remove
 * it, never the subject. Samples the border colour, then edge-connected flood-fills that colour from
 * the borders inward — so a disconnected subject can NEVER be deleted (the failure mode of rembg's
 * salient-object detection, which threw away the dark raccoon). Clean cut on flat/white/solid
 * backgrounds; on a full-scene design the border isn't uniform → returns as-is (removed:false) so the
 * UI can steer the user to the opacity/blend tool instead.
 */
export async function removeUniformBackground(
  srcBuf: Buffer,
  opts?: { tolerance?: number; fuzz?: number; force?: boolean },
): Promise<{ buf: Buffer; removed: boolean; borderUniform: boolean }> {
  const { color, uniform } = await sampleBorderColor(srcBuf);
  if (!uniform && !opts?.force) return { buf: srcBuf, removed: false, borderUniform: false };
  const buf = await knockoutColors(srcBuf, {
    targets: [color], tolerance: opts?.tolerance ?? 55, fuzz: opts?.fuzz ?? 50, mode: "flood", defringe: true,
  });
  return { buf, removed: true, borderUniform: uniform };
}

/**
 * Luminance-keyed opacity / "blend into garment" (PO 2026-06-17). For a full-SCENE design (the
 * raccoon night street) where there's no uniform area to cut, fade the DARK + DESATURATED areas to
 * transparent so the scene melts into a dark shirt, while the light subject + colourful elements stay
 * opaque. Keys on BOTH luminance AND saturation: a pixel stays opaque if it's bright OR colourful —
 * so the dark grey/black night scene drops out, but the LIGHT fur AND the dark-but-SATURATED red can
 * both survive (pure luminance would wrongly fade the red can, which has low luminance).
 *
 * alpha *= max( smoothstep(darkPoint,lightPoint, luminance), smoothstep(satLow,satKeep, saturation) )
 */
export async function reduceBackgroundOpacity(
  srcBuf: Buffer,
  opts?: { darkPoint?: number; lightPoint?: number; satKeep?: number },
): Promise<Buffer> {
  // More fade (PO 2026-06-17: the first pass was too subtle — the mid-tone scene, bokeh + curb, stayed
  // so the mockup "looked like before"). Raised so the whole night scene drops out, leaving the
  // raccoon's lighter fur + the (saturation-kept) red can. Below darkPoint → fully transparent; above
  // lightPoint → fully opaque; saturated pixels stay regardless.
  const dark = opts?.darkPoint ?? 70;
  const light = opts?.lightPoint ?? 145;
  const satKeep = opts?.satKeep ?? 55;
  const { data, info } = await sharp(srcBuf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height;
  const out = Buffer.from(data);
  for (let i = 0; i < W * H; i++) {
    const o = i * 4;
    const a = data[o + 3];
    if (a === 0) continue;
    const r = data[o], g = data[o + 1], b = data[o + 2];
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    const sat = Math.max(r, g, b) - Math.min(r, g, b);
    const mult = Math.max(smoothstep(dark, light, lum), smoothstep(satKeep * 0.55, satKeep, sat));
    out[o + 3] = Math.round(a * mult);
  }
  return sharp(out, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer();
}
