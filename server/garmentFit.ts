/**
 * Garment-fit guidance (PO 2026-06-17, print-shop plan CP4). The deterministic color-matcher
 * (mockupColorMatcher) optimizes for "every ink visible", so it PENALIZES dark shirts when a design
 * has any dark elements — which is why it never surfaced BLACK for the photoreal raccoon, even though
 * a 30-yr printer says that vintage design belongs on black (the light fur pops; the dark bits merging
 * into the shirt IS the look). This is an ADVISORY layer that recommends garment direction from the
 * design's light/dark content, plus the DTF white-underbase reminder for dark shirts. It does NOT
 * touch pickBestColors (that stays conservative — the Kitchen Violation dark-on-dark lesson).
 */
import sharp from "sharp";

export interface GarmentFit {
  lightShare: number;            // fraction of the design that is light/bright (luminance > 180)
  darkShare: number;             // fraction that is dark (luminance < 75)
  recommendDarkShirt: boolean;   // enough light content to pop on black/charcoal
  recommendLightShirt: boolean;  // enough dark content to pop on white/cream
  needsUnderbase: boolean;       // a dark-shirt recommendation → DTF must lay white under the ink
  underbaseNote: string | null;
  summary: string;
}

export async function analyzeGarmentFit(srcBuf: Buffer): Promise<GarmentFit> {
  const { data, info } = await sharp(srcBuf)
    .ensureAlpha()
    .resize(128, 128, { fit: "inside" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width: w, height: h, channels: ch } = info;

  let opaque = 0, light = 0, dark = 0;
  for (let i = 0; i < w * h; i++) {
    const o = i * ch;
    if (data[o + 3] < 40) continue;
    opaque++;
    const lum = 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
    if (lum > 180) light++;
    else if (lum < 75) dark++;
  }

  if (opaque === 0) {
    return {
      lightShare: 0, darkShare: 0, recommendDarkShirt: false, recommendLightShirt: true,
      needsUnderbase: false, underbaseNote: null, summary: "Could not read the design — defaulting to light garments.",
    };
  }

  const lightShare = light / opaque;
  const darkShare = dark / opaque;
  // A LIGHT focal element (even ~8%) is what makes a design pop on BLACK — the vintage look. The
  // contrast matcher misses this because it averages over all inks. A DARK element pops on WHITE.
  const recommendDarkShirt = lightShare >= 0.08;
  const recommendLightShirt = darkShare >= 0.08;
  const needsUnderbase = recommendDarkShirt;
  const underbaseNote = needsUnderbase
    ? "On a dark shirt (DTF), the printer lays a WHITE underbase under the ink so the light areas show. Confirm your RIP generates white from the PNG's transparency before ordering a dark-garment run."
    : null;

  // Lead with the stronger pop. A full-range grayscale design (raccoon) works on BOTH — surface that,
  // and call out black as the classic vintage pick since that's the one the matcher hides.
  let summary: string;
  if (recommendDarkShirt && recommendLightShirt) {
    summary = "Full-range design — works on BOTH: **black / charcoal** (vintage look, the light areas pop — the matcher under-surfaces this) and **white / cream** (the dark areas read). Black is the classic vintage pick; it needs a white underbase.";
  } else if (recommendDarkShirt) {
    summary = "Strong light content — pops on **black / charcoal** (classic vintage look; needs a white underbase).";
  } else if (recommendLightShirt) {
    summary = "Strong dark content — reads best on **white / cream**.";
  } else {
    summary = "Mid-tone design — reads on a range of garment colors; pick by style.";
  }

  return { lightShare, darkShare, recommendDarkShirt, recommendLightShirt, needsUnderbase, underbaseNote, summary };
}
