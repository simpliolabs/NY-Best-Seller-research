/**
 * Per-run mockup TREATMENT (PO 2026-06-25). Applies a treatment — cutout / blend / knockout — to a
 * design FOR A SINGLE MOCKUP + PRINT RUN. It does NOT create a design version (no design_revisions
 * row); the treated PNG is stored and its url returned so the SAME bytes feed both the mockups and the
 * print file. Re-runs reuse the cached cut instead of re-paying BiRefNet.
 *
 * CP2 invariant: this only ever runs from an EXPLICIT choice — the user's Manual pick or the Automatic
 * Mockup Council — never silently inside the compositor. The compositor still just composites whatever
 * url it's handed; it decides nothing. `type:"none"` is a pure pass-through (returns the source url).
 *
 * Cache key = sha256(sourceUrl | TREATMENT_ALGO_VERSION | type | params). The sourceUrl is in the key
 * and storagePut hash-suffixes every upload, so a design edit changes the source url and the cache can
 * never serve a treated cut of stale art; TREATMENT_ALGO_VERSION guards an algorithm/model change.
 */
import { createHash } from "crypto";
import { storagePut } from "./storage";
import { fadeOpacity, knockoutColors, sampleBorderColor, hexToRgb } from "./knockout";
import type { RGB } from "./knockout";
import { removeBackgroundViaBiRefNet } from "./revisionEngine";
import { getTreatedUrl, putTreatedUrl } from "./treatedCacheDb";

/** Bump when ANY treatment algorithm or model changes, so the cache can't serve a stale-algo image. */
export const TREATMENT_ALGO_VERSION = "v3-birefnet+uniformfade0.6+flood";

/** Blend opacity — how much of the shirt shows through the kept scene (PO 2026-06-25: keep the scene,
 *  just lower opacity so it fades into the fabric). Lower = more faded/blended. Tuned from a preview. */
export const BLEND_OPACITY = 0.6;

export type TreatmentType = "none" | "cutout" | "blend" | "knockout";

export interface TreatmentPlan {
  type: TreatmentType;
  /** Knockout only: hex colors to delete. Empty/omitted = auto-sample the uniform border (background). */
  knockoutTargets?: string[];
}

async function fetchBuf(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`treatment: failed to fetch source ${url} (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Apply `plan` to `sourceUrl`, returning the treated image url (or `sourceUrl` unchanged for "none").
 * Cached; cutout falls back to the deterministic flood if BiRefNet errors so a run never hard-fails.
 */
export async function applyTreatment(sourceUrl: string, plan: TreatmentPlan): Promise<string> {
  if (plan.type === "none") return sourceUrl;

  const paramKey =
    plan.type === "knockout"
      ? (plan.knockoutTargets ?? []).map((s) => s.toLowerCase()).sort().join(",")
      : "";
  const hash = createHash("sha256")
    .update(`${sourceUrl}|${TREATMENT_ALGO_VERSION}|${plan.type}|${paramKey}`)
    .digest("hex");

  const cached = await getTreatedUrl(hash);
  if (cached) return cached;

  let out: Buffer;
  if (plan.type === "cutout") {
    // BiRefNet matting (keeps the whole subject); deterministic flood fallback (never deletes subject).
    try {
      out = await removeBackgroundViaBiRefNet(sourceUrl);
    } catch (err) {
      console.warn("[treatment] BiRefNet failed, falling back to deterministic flood:", err);
      const { removeUniformBackground } = await import("./knockout");
      out = (await removeUniformBackground(await fetchBuf(sourceUrl), { force: true })).buf;
    }
  } else if (plan.type === "blend") {
    // Keep the FULL scene, just lower its opacity uniformly so it fades into the shirt's fabric + folds
    // (PO 2026-06-25: "KEEP THE SCENE and just lower opacity and blend better to curves of shirts, NOT
    // remove the entire background"). Uniform alpha — NOT the luminance key, which punched transparent
    // holes in the raccoon's dark fur and read as a ghosted color-knockout on colored shirts.
    out = await fadeOpacity(await fetchBuf(sourceUrl), BLEND_OPACITY);
  } else {
    // knockout: explicit hex targets, else auto-sample the uniform border (the background color).
    const buf = await fetchBuf(sourceUrl);
    let targets: RGB[] = (plan.knockoutTargets ?? [])
      .map(hexToRgb)
      .filter((c): c is RGB => c !== null);
    if (targets.length === 0) {
      // Auto-knockout only a UNIFORM border (a genuine flat background). On a non-uniform/scene border
      // there's no safe color to flood — bail to the untreated source rather than eat border-connected
      // art, matching removeUniformBackground's invariant (CP2: don't transform when there's no flat bg).
      const border = await sampleBorderColor(buf);
      if (!border.uniform) return sourceUrl;
      targets = [border.color];
    }
    out = await knockoutColors(buf, { targets, mode: "flood", defringe: true });
  }

  const { url } = await storagePut(`print-treated/${hash}.png`, out, "image/png");
  await putTreatedUrl(hash, url);
  return url;
}
