/**
 * Design-type classifier (PO 2026-06-17, print-shop plan CP3). Deterministically classifies a design
 * so the UI can RECOMMEND the right print treatment — and stop offering one-click halftone/knockout
 * on a photoreal continuous-tone design (the raccoon black-blob lesson).
 *
 * Heuristic (from the Photoshop-production review): color spread. A flat/vector design is a few solid
 * colors covering most of the canvas (high top-color share, few distinct colors). A photoreal/gradient
 * design is thousands of low-weight colors (low top-color share). Cheap, deterministic, explainable.
 *
 * IMPORTANT (adversary): this RECOMMENDS, it does not gate. The UI must WARN, never grey-out — the
 * classifier misfires on grunge-vintage and gradient-background designs, exactly when knockout is
 * wanted. Leave every tool reachable.
 */
import sharp from "sharp";

export type DesignType = "photoreal-fullcolor" | "limited-color-stylized" | "one-or-two-color";
export type Fit = "recommended" | "ok" | "not-recommended";

export interface DesignClassification {
  type: DesignType;
  confidence: number;       // 0..1, distance from the nearest boundary
  distinctColors: number;   // quantized (4-bit/chan) distinct opaque colors
  topColorShare: number;    // fraction of opaque pixels in the top 8 colors
  recommendations: { dtfFulltone: Fit; knockout: Fit; halftone: Fit };
  reason: string;
}

export async function classifyDesignType(srcBuf: Buffer): Promise<DesignClassification> {
  const { data, info } = await sharp(srcBuf)
    .ensureAlpha()
    .resize(128, 128, { fit: "inside" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width: w, height: h, channels: ch } = info;

  const counts = new Map<number, number>();
  let opaque = 0;
  for (let i = 0; i < w * h; i++) {
    const o = i * ch;
    if (data[o + 3] < 40) continue; // skip transparent
    opaque++;
    const r = data[o] & 0xf0, g = data[o + 1] & 0xf0, b = data[o + 2] & 0xf0; // 4-bit/chan quantize
    const key = (r << 16) | (g << 8) | b;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  // Degenerate (all transparent / unreadable) → safest default: full-tone, warn on the rest.
  if (opaque === 0) {
    return {
      type: "limited-color-stylized", confidence: 0, distinctColors: 0, topColorShare: 1,
      recommendations: { dtfFulltone: "recommended", knockout: "ok", halftone: "ok" },
      reason: "Could not read the design colors — defaulting to full-color DTF; other tools available with a test print.",
    };
  }

  const distinctColors = counts.size;
  const sorted = Array.from(counts.values()).sort((a, b) => b - a);
  const top8 = sorted.slice(0, 8).reduce((s, n) => s + n, 0);
  const topColorShare = top8 / opaque;

  let type: DesignType;
  let recommendations: DesignClassification["recommendations"];
  let reason: string;
  let confidence: number;

  if (topColorShare >= 0.85 && distinctColors <= 10) {
    type = "one-or-two-color";
    recommendations = { dtfFulltone: "recommended", knockout: "recommended", halftone: "recommended" };
    reason = "1–2 color / line art — a great color-knockout + halftone candidate (and a true screen-print candidate).";
    confidence = Math.min(1, (topColorShare - 0.85) / 0.15 + 0.5);
  } else if (topColorShare >= 0.6) {
    type = "limited-color-stylized";
    recommendations = { dtfFulltone: "recommended", knockout: "recommended", halftone: "ok" };
    reason = "Stylized limited-color art — full-color DTF works; color knockout (let the shirt show through) fits well; halftone gives a vintage texture (verify on a test print).";
    confidence = 0.5 + Math.min(0.5, Math.abs(topColorShare - 0.72) / 0.24);
  } else {
    type = "photoreal-fullcolor";
    recommendations = { dtfFulltone: "recommended", knockout: "not-recommended", halftone: "not-recommended" };
    reason = "Photoreal / full-color art — print full-color DTF. Knockout and halftone will DEGRADE a continuous-tone design (this is why a black halftone of a photoreal design looks wrong). Use them only if you know the design suits it.";
    confidence = Math.min(1, (0.6 - topColorShare) / 0.4 + 0.3);
  }

  return { type, confidence: Math.max(0, Math.min(1, confidence)), distinctColors, topColorShare, recommendations, reason };
}
