/**
 * Mockup Color Matcher — DETERMINISTIC contrast-based blank selection (PO 2026-06-09).
 *
 * Picks the N shirt-blank colors on which the design is MOST VISIBLE. It reads the design's
 * actual dominant ink colors and scores every blank by contrast, so a navy design never lands on
 * a navy/black shirt, a brown design never on brown, etc. No LLM — the previous LLM matcher
 * guessed unreliably (it could put a design on a same-color shirt where it's invisible).
 *
 * Verified on the live Salty Dinker design (dominant ink = navy ~34%): picks White/Ivory/Yellow/
 * Sandstone/Pink/LightBlue/HeatherGray; pushes Navy/Black/Brown/Forest to the bottom.
 *
 * Karpathy: one deterministic, explainable path. Pure functions, no over-abstraction.
 */
import sharp from "sharp";
import type { MockupTemplate } from "../drizzle/schema";

interface RGB { r: number; g: number; b: number; }

function hexToRgb(hex: string): RGB | null {
  const m = hex.trim().replace(/^#/, "");
  if (m.length !== 6) return null;
  const r = parseInt(m.slice(0, 2), 16);
  const g = parseInt(m.slice(2, 4), 16);
  const b = parseInt(m.slice(4, 6), 16);
  if ([r, g, b].some((v) => Number.isNaN(v))) return null;
  return { r, g, b };
}

const lum = (c: RGB) => 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;

/**
 * Visibility of an ink color on a blank: 0 (invisible — same color) .. 1 (max contrast).
 * Blends luminance contrast (does it pop light-on-dark / dark-on-light) with raw RGB distance
 * (does it differ in hue/chroma), so e.g. navy-on-black scores low even though both are darkish.
 */
function visibility(ink: RGB, blank: RGB): number {
  const dLum = Math.abs(lum(ink) - lum(blank)) / 255;
  const dr = ink.r - blank.r, dg = ink.g - blank.g, db = ink.b - blank.b;
  const dist = Math.sqrt(dr * dr + dg * dg + db * db) / 441.673; // / sqrt(3 * 255^2)
  return 0.55 * dLum + 0.45 * dist;
}

/**
 * Extract the design's dominant OPAQUE ink colors (quantized to 16 levels/channel) with area
 * weights (fraction of opaque pixels). Transparent/near-transparent pixels are ignored so the
 * background never skews the match.
 */
async function extractDesignPalette(
  designImageUrl: string,
): Promise<Array<RGB & { weight: number }>> {
  const res = await fetch(designImageUrl);
  if (!res.ok) throw new Error(`design fetch failed: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const { data, info } = await sharp(buf)
    .ensureAlpha()
    .resize(128, 128, { fit: "inside" }) // small = fast; dominant colors survive downscale
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width: w, height: h, channels: ch } = info;

  const counts = new Map<number, number>();
  let opaque = 0;
  for (let i = 0; i < w * h; i++) {
    const o = i * ch;
    if (data[o + 3] < 40) continue; // skip transparent / anti-aliased edges
    opaque++;
    const r = data[o] & 0xf0, g = data[o + 1] & 0xf0, b = data[o + 2] & 0xf0;
    const key = (r << 16) | (g << 8) | b;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  if (opaque === 0) return [];
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([key, n]) => ({ r: (key >> 16) & 0xff, g: (key >> 8) & 0xff, b: key & 0xff, weight: n / opaque }));
}

/**
 * Pick the `count` blank colors on which the design reads best (highest area-weighted contrast).
 * A high-area ink color that is near-invisible on a blank drags that blank's score down, so
 * same/near-color shirts are naturally excluded. Falls back to the first `count` templates if the
 * design image can't be analyzed (network/format failure) — never blocks mockup generation.
 */
export async function pickBestColors(
  designImageUrl: string,
  templates: MockupTemplate[],
  count: number,
): Promise<MockupTemplate[]> {
  if (templates.length <= count) return templates;

  let palette: Array<RGB & { weight: number }>;
  try {
    palette = await extractDesignPalette(designImageUrl);
  } catch (err) {
    console.warn("[ColorMatch] palette extraction failed, using first N templates:", err);
    return templates.slice(0, count);
  }
  if (palette.length === 0) return templates.slice(0, count);

  const scored = templates.map((t) => {
    const blank = hexToRgb(t.colorHex);
    if (!blank) return { t, score: -1 }; // malformed hex sinks to the bottom
    let score = 0;
    for (const c of palette) score += c.weight * visibility(c, blank);
    return { t, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, count).map((s) => s.t);
}
