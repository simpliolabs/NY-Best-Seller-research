/**
 * Mockup Compositor — Phase H
 * Downloads a transparent design PNG and a blank shirt photo,
 * resizes the design to fit the print zone, and composites them.
 * Karpathy: one function, no class hierarchy, no speculative abstractions.
 */
import sharp from "sharp";
import { generateImage } from "./_core/imageGeneration";

export interface PrintArea {
  x: number;      // ratio 0-1 (left offset within garment bbox)
  y: number;      // ratio 0-1 (top offset within garment bbox)
  width: number;  // ratio 0-1
  height: number; // ratio 0-1
}

/** @deprecated Use PrintArea instead */
export type PrintZone = PrintArea;

export interface CompositeConfig {
  designUrl: string;   // Transparent PNG from S3
  mockupUrl: string;   // Blank shirt photo from S3
  printZone: PrintArea;
  /** Hex color of the shirt this is being composited onto, e.g. "#0e1c2e".
   *  When provided, the design is run through shirt-aware halftone + knockout BEFORE
   *  composite — pixels close to the shirt color get knocked out (let the shirt show
   *  through), mid-contrast pixels become a Bayer dot pattern (vintage screen-print
   *  feel, shirt color reads through the gaps), high-contrast pixels stay solid.
   *  Result: the design looks PRINTED INTO the fabric instead of sitting on top like
   *  a plastic decal. PO insight: halftone effect is shirt-color-dependent, so this
   *  belongs at composite time, not at production time. */
  shirtColorHex?: string;
  /** Vertical placement of the design WITHIN the print zone. PO rule (2026-06-08):
   *  apparel (worn) = "top" (centered horizontally, top-anchored so the print sits
   *  upper-chest); objects (mug/cup/tumbler/tote/poster) = "center" (dead-centered).
   *  Horizontal is ALWAYS centered. Defaults to "top" (apparel is the primary product). */
  anchorY?: "top" | "center";
  /** OPTIONAL perspective warp (DEFERRED — off by default). When set, the design is
   *  keystone-warped to these 4 corner points (0..1 photo-relative) instead of placed in
   *  the axis-aligned box — for fabric-drape/angle realism (PSD smart-object parity).
   *  Not implemented yet (sharp has no native perspective op); the param exists so the
   *  future quad layer has a stable home. Today: if set, we fall through to the affine
   *  box placement (no crash) and warn. */
  quad?: { tl: [number, number]; tr: [number, number]; br: [number, number]; bl: [number, number] };
}

// 8×8 Bayer ordered-dither matrix (0..63). Used by applyShirtAwareHalftone.
const BAYER_8X8 = [
   0, 32,  8, 40,  2, 34, 10, 42,
  48, 16, 56, 24, 50, 18, 58, 26,
  12, 44,  4, 36, 14, 46,  6, 38,
  60, 28, 52, 20, 62, 30, 54, 22,
   3, 35, 11, 43,  1, 33,  9, 41,
  51, 19, 59, 27, 49, 17, 57, 25,
  15, 47,  7, 39, 13, 45,  5, 37,
  63, 31, 55, 23, 61, 29, 53, 21,
];

// Thresholds tuned against test runs on Salty Dinker across cream/black/navy shirts
// — see test-salty-shirt-aware.cjs and the conversation log. PO confirmed default look.
const HALFTONE_KNOCKOUT_THRESHOLD = 0.20;  // contrast below = pixel too close to shirt → alpha=0
const HALFTONE_KEEP_SOLID_THRESHOLD = 0.65; // contrast above = pure ink → keep all pixels

function parseHexColor(hex: string): { r: number; g: number; b: number } {
  const m = hex.trim().replace(/^#/, "");
  if (m.length !== 6) throw new Error(`Invalid hex color: ${hex}`);
  return {
    r: parseInt(m.slice(0, 2), 16),
    g: parseInt(m.slice(2, 4), 16),
    b: parseInt(m.slice(4, 6), 16),
  };
}

/**
 * Apply shirt-aware knockout + halftone to a transparent design PNG.
 * Uses max-channel-diff contrast against the shirt color (better than luminance-only —
 * catches hue differences like yellow-on-cream that share luminance but read very
 * differently).
 *
 * Rules per pixel:
 *   contrast = max(|R-Rs|, |G-Gs|, |B-Bs|) / 255
 *   contrast < KNOCKOUT  → alpha=0       (pixel invisible on shirt, let shirt show)
 *   contrast > KEEP_SOLID → keep opaque  (pure ink, high contrast)
 *   else                  → Bayer halftone, density proportional to contrast
 *
 * This is what makes "navy text on navy shirt" honestly disappear (correct print-prep
 * behavior — same-color ink on same-color shirt IS invisible) instead of pretending.
 */
export async function applyShirtAwareHalftone(
  designBuf: Buffer,
  shirtColorHex: string
): Promise<Buffer> {
  const shirt = parseHexColor(shirtColorHex);
  const { data, info } = await sharp(designBuf)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width: w, height: h, channels: ch } = info;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * ch;
      // Already transparent (the productionDesignUrl's existing transparency) — leave it
      if (data[i + 3] < 16) continue;
      const dr = Math.abs(data[i]     - shirt.r);
      const dg = Math.abs(data[i + 1] - shirt.g);
      const db = Math.abs(data[i + 2] - shirt.b);
      const contrast = Math.max(dr, dg, db) / 255;

      if (contrast < HALFTONE_KNOCKOUT_THRESHOLD) {
        data[i + 3] = 0;
      } else if (contrast > HALFTONE_KEEP_SOLID_THRESHOLD) {
        // keep solid — no change
      } else {
        // Mid-contrast → Bayer halftone. Density proportional to contrast.
        const norm = (contrast - HALFTONE_KNOCKOUT_THRESHOLD) / (HALFTONE_KEEP_SOLID_THRESHOLD - HALFTONE_KNOCKOUT_THRESHOLD);
        const bayerVal = BAYER_8X8[(y % 8) * 8 + (x % 8)];
        const bayerThresh = (bayerVal + 0.5) / 64;
        if (norm <= bayerThresh) data[i + 3] = 0;
      }
    }
  }

  return sharp(data, { raw: { width: w, height: h, channels: ch } })
    .png()
    .toBuffer();
}

/** Default print AREA — PHOTO-RELATIVE fallback (fractions of the whole photo).
 * 2026-06-08 FOUNDATIONAL CHANGE: print zones are now photo-relative (the exact
 * rectangle the human draws on the template), NOT garment-bbox-relative. The old
 * vision-LLM garment-box detection was removed — LLMs locate bounding boxes poorly
 * (research: often wrong quadrant, ~13% IoU), which made placement off-center/off-
 * location and was cached so it persisted. POD platforms (Printful/Printify) use
 * fixed human-defined print areas; we now do the same.
 * This DEFAULT is a sane centered chest rectangle in PHOTO coords for a flat-lay
 * shirt — FALLBACK ONLY; draw a per-group zone for precise control. With anchorY
 * "top" the design sits upper-mid chest; "center" dead-centers it.
 */
export const DEFAULT_PRINT_AREA: PrintArea = {
  x: 0.34,
  y: 0.30,
  width: 0.32,
  height: 0.30,
};

/**
 * Resolve the print area for ONE template (PO 2026-06-09, per-template print areas).
 * Priority: the per-template box (mockup_templates.garmentBbox — repurposed as that color's
 * own calibrated print rectangle) → the group's shared zone → DEFAULT_PRINT_AREA.
 * TOTAL + divide-safe: validates each candidate (finite + positive width/height) and returns a
 * FRESH {x,y,width,height}; malformed/empty values fall through instead of crashing the
 * per-template composite loop. Takes PRIMITIVES (not Drizzle rows) so this module stays
 * schema-free. Inches (widthIn/heightIn) are intentionally NOT used here — the box is placed
 * VERBATIM (the editor already aspect-locked it to inches on that color's own photo; reshaping
 * here would re-introduce per-color drift).
 */
export function resolvePrintZone(
  templateArea: PrintArea | null | undefined,
  groupZone: PrintArea | null | undefined,
): PrintArea {
  const ok = (z: PrintArea | null | undefined): z is PrintArea =>
    !!z && Number.isFinite(z.x) && Number.isFinite(z.y) &&
    Number.isFinite(z.width) && Number.isFinite(z.height) && z.width > 0 && z.height > 0;
  if (ok(templateArea)) return { x: templateArea.x, y: templateArea.y, width: templateArea.width, height: templateArea.height };
  if (ok(groupZone)) return { x: groupZone.x, y: groupZone.y, width: groupZone.width, height: groupZone.height };
  return { ...DEFAULT_PRINT_AREA };
}

/**
 * Place a design inside a box (CONTAIN-FIT, aspect preserved). Pure helper extracted
 * byte-identically from the inline composite math (PO 2026-06-09) so the deferred quad-warp
 * branch has a single home. Given design + box PIXEL dims + the vertical anchor, returns the
 * resized dims and the offset WITHIN the box (the caller adds the box's top-left). Horizontal is
 * ALWAYS centered; vertical "top" (apparel) pins to 0, "center" (objects) centers.
 */
function placeInBox(
  designW: number,
  designH: number,
  boxW: number,
  boxH: number,
  anchorY: "top" | "center" | undefined,
): { finalW: number; finalH: number; offsetX: number; offsetY: number } {
  const scale = Math.min(boxW / designW, boxH / designH);
  const finalW = Math.round(designW * scale);
  const finalH = Math.round(designH * scale);
  const offsetX = Math.round((boxW - finalW) / 2);
  const offsetY = anchorY === "center" ? Math.round((boxH - finalH) / 2) : 0;
  return { finalW, finalH, offsetX, offsetY };
}

// Apparel product types are worn on the body → the print is centered-to-TOP of the
// chest. Everything else (mug, cup, tumbler, tote, poster, sticker) is an object →
// the print is CENTERED on its surface. Unknown defaults to apparel (primary product).
const APPAREL_PRODUCT_TYPES = ["t-shirt", "tee", "shirt", "hoodie", "sweatshirt", "tank", "crewneck", "long sleeve", "longsleeve", "apparel"];
export function anchorForProductType(productType?: string | null): "top" | "center" {
  const pt = (productType ?? "").toLowerCase().trim();
  if (!pt) return "top";
  return APPAREL_PRODUCT_TYPES.some((a) => pt.includes(a)) ? "top" : "center";
}

/** @deprecated Use DEFAULT_PRINT_AREA instead */
export const DEFAULT_PRINT_ZONE = DEFAULT_PRINT_AREA;

async function downloadImage(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download image: ${url} (${res.status})`);
  const arrayBuf = await res.arrayBuffer();
  return Buffer.from(arrayBuf);
}

/**
 * Remove background from a design image.
 * Strategy:
 * 1. First try simple white-pixel removal (works when AI follows the white-bg prompt)
 * 2. If the image appears to be a full mockup (shirt on background), use AI edit mode
 *    to extract just the graphic design.
 */
export async function removeBackground(imageBuf: Buffer): Promise<Buffer> {
  try {
    // Analyze the image to determine if it's already transparent, on white, or a full mockup
    const { data, info } = await sharp(imageBuf)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const { width, height, channels } = info;
    const edgeSize = 20; // Check 20px border
    // Match the flood-fill threshold: 235 catches near-white AI backgrounds (r≈219-252)
    const THRESHOLD = 235;

    let whiteEdgePixels = 0;
    let transparentEdgePixels = 0;
    let totalEdgePixels = 0;

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (x < edgeSize || x >= width - edgeSize || y < edgeSize || y >= height - edgeSize) {
          const idx = (y * width + x) * channels;
          const r = data[idx];
          const g = data[idx + 1];
          const b = data[idx + 2];
          const a = data[idx + 3];
          totalEdgePixels++;
          if (a < 30) {
            transparentEdgePixels++;
          } else if (r > THRESHOLD && g > THRESHOLD && b > THRESHOLD) {
            whiteEdgePixels++;
          }
        }
      }
    }

    const transparentEdgeRatio = transparentEdgePixels / totalEdgePixels;
    const whiteEdgeRatio = whiteEdgePixels / totalEdgePixels;
    console.log(`[BG Removal] Transparent edge ratio: ${(transparentEdgeRatio * 100).toFixed(1)}%, White edge ratio: ${(whiteEdgeRatio * 100).toFixed(1)}%`);

    if (transparentEdgeRatio > 0.3) {
      // Already transparent — skip removal entirely
      return imageBuf;
    } else if (whiteEdgeRatio > 0.3) {
      // Near-white or pure-white background (typical output from AI image generators
      // following the DTF prompt). Use flood-fill removal — it's fast, preserves
      // interior white design elements, and avoids the AI extraction round-trip.
      // Threshold 220 catches near-white (r≈235) as well as pure white (r=255).
      const { data, info } = await sharp(imageBuf)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      return simpleWhiteRemoval(data, info);
    } else {
      // Colored/textured background (legacy shirt mockup images).
      // Use AI extraction to isolate the design from the shirt.
      return await aiDesignExtraction(imageBuf);
    }
  } catch (err) {
    console.warn("[BG Removal] Failed, using original image:", err);
    return imageBuf;
  }
}

/**
 * Crop an image to the bounding box of its colored (non-white, non-transparent) content.
 * Used after AI extraction to remove the white padding the AI adds around designs.
 * White pixels inside the design (paddle face, net interior) are preserved because
 * we only crop the CANVAS — we don't modify any pixel values.
 */
async function cropToColoredContent(imageBuf: Buffer): Promise<Buffer> {
  try {
    const { data, info } = await sharp(imageBuf)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const { width, height, channels } = info;

    // Find bounding box of non-transparent pixels
    let minX = width, maxX = 0, minY = height, maxY = 0;
    let found = false;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = (y * width + x) * channels;
        const a = data[idx + 3];
        if (a > 30) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
          found = true;
        }
      }
    }

    if (!found) return imageBuf; // Fully transparent — return as-is

    // Add 4px padding so we don't clip anti-aliased edges
    const pad = 4;
    const left = Math.max(0, minX - pad);
    const top = Math.max(0, minY - pad);
    const cropW = Math.min(width - left, maxX - left + 1 + pad);
    const cropH = Math.min(height - top, maxY - top + 1 + pad);

    // Only crop if it actually reduces the canvas meaningfully (> 5% reduction)
    const reduction = 1 - (cropW * cropH) / (width * height);
    if (reduction < 0.05) return imageBuf;

    return sharp(imageBuf)
      .extract({ left, top, width: cropW, height: cropH })
      .toBuffer();
  } catch {
    return imageBuf;
  }
}

/**
 * Edge-connected flood-fill white removal.
 * Only removes white pixels that are reachable from the image border.
 * This preserves white elements INSIDE the design (e.g., white net fills, white text).
 * Threshold 235 catches near-white backgrounds (r≈219-252) that AI image generators
 * produce instead of pure white (r=255). Edge-connected fill means interior white
 * design elements are never touched regardless of threshold.
 */
function simpleWhiteRemoval(data: Buffer, info: { width: number; height: number; channels: number }): Promise<Buffer> {
  const { width, height, channels } = info;
  const THRESHOLD = 235;

  const output = Buffer.from(data);
  const visited = new Uint8Array(width * height);
  const queue: number[] = [];

  // Seed the flood fill from all edge pixels that are white
  const isWhite = (idx: number) => {
    return output[idx] > THRESHOLD && output[idx + 1] > THRESHOLD && output[idx + 2] > THRESHOLD;
  };

  for (let x = 0; x < width; x++) {
    const topIdx = (0 * width + x) * channels;
    const botIdx = ((height - 1) * width + x) * channels;
    if (isWhite(topIdx) && !visited[x]) { visited[x] = 1; queue.push(x); }
    const botPx = (height - 1) * width + x;
    if (isWhite(botIdx) && !visited[botPx]) { visited[botPx] = 1; queue.push(botPx); }
  }
  for (let y = 1; y < height - 1; y++) {
    const leftPx = y * width;
    const rightPx = y * width + (width - 1);
    if (isWhite(leftPx * channels) && !visited[leftPx]) { visited[leftPx] = 1; queue.push(leftPx); }
    if (isWhite(rightPx * channels) && !visited[rightPx]) { visited[rightPx] = 1; queue.push(rightPx); }
  }

  // BFS flood fill
  while (queue.length > 0) {
    const px = queue.pop()!;
    const py = Math.floor(px / width);
    const px_x = px % width;
    // Make transparent
    const idx = px * channels;
    output[idx + 3] = 0;

    // Check 4 neighbors
    const neighbors = [
      px - 1, px + 1,
      px - width, px + width,
    ];
    for (const n of neighbors) {
      const ny = Math.floor(n / width);
      const nx = n % width;
      if (n < 0 || n >= width * height) continue;
      if (Math.abs(ny - py) > 1 && Math.abs(nx - px_x) > 1) continue; // wrap guard
      if (visited[n]) continue;
      if (isWhite(n * channels)) {
        visited[n] = 1;
        queue.push(n);
      }
    }
  }

  return sharp(output, { raw: { width, height, channels: channels as 4 } })
    .png()
    .toBuffer();
}

/**
 * AI-powered design extraction for images that show a design on a shirt/colored background.
 * Uses the image generation edit mode to isolate just the graphic design.
 */
async function aiDesignExtraction(imageBuf: Buffer): Promise<Buffer> {
  try {
    const b64 = imageBuf.toString("base64");
    const result = await generateImage({
      prompt: "Extract ONLY the graphic design/artwork from this t-shirt image. Remove the t-shirt, remove any background (wooden planks, fabric texture, etc). Output ONLY the isolated graphic design elements (text, illustrations, badges, icons) on a pure white background. The design should be centered with white space around it. No shirt, no background, no shadows — just the flat graphic artwork.",
      originalImages: [{
        b64Json: b64,
        mimeType: "image/png",
      }],
    });

    if (!result.url) {
      console.warn("[AI Extraction] No URL returned, falling back to original");
      return imageBuf;
    }

    // Download the extracted design
    const res = await fetch(result.url);
    if (!res.ok) throw new Error(`Failed to download extracted design: ${res.status}`);
    const extractedBuf = Buffer.from(await res.arrayBuffer());

    // Apply simple white removal on the extracted design (which should be on white bg)
    const { data, info } = await sharp(extractedBuf)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const noBg = await simpleWhiteRemoval(data, info);

    // Crop to the bounding box of non-transparent content.
    // The AI often returns a larger canvas with the design not centered — crop removes
    // the excess transparent area so the design fills its bounding box correctly.
    return cropToColoredContent(noBg);
  } catch (err) {
    console.warn("[AI Extraction] Failed, falling back to simple removal:", err);
    // Fall back to simple removal
    const { data, info } = await sharp(imageBuf)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    return simpleWhiteRemoval(data, info);
  }
}

/**
 * Trim transparent pixels from a design image to get the actual content bounds.
 * This ensures the design fills the print zone properly without excess whitespace.
 */
async function trimDesign(designBuf: Buffer): Promise<Buffer> {
  try {
    // Trim transparent/near-transparent edges
    const trimmed = await sharp(designBuf)
      .trim({ threshold: 10 })
      .toBuffer();
    return trimmed;
  } catch {
    // If trim fails (e.g., entirely transparent), return original
    return designBuf;
  }
}

/**
 * Smart content trim: handles both white-background and transparent designs.
 * For white-background images: uses Sharp's native trim with white background color.
 * For transparent images: uses Sharp's native trim on alpha channel.
 * NEVER removes white pixels from inside the design content.
 */
async function trimToContent(imageBuf: Buffer): Promise<Buffer> {
  try {
    const { data, info } = await sharp(imageBuf)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const { width, height, channels } = info;
    const edgeSize = 20;
    const THRESHOLD = 240;

    // Check if edges are transparent
    let transparentEdge = 0;
    let totalEdge = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (x < edgeSize || x >= width - edgeSize || y < edgeSize || y >= height - edgeSize) {
          const a = data[(y * width + x) * channels + 3];
          totalEdge++;
          if (a < 30) transparentEdge++;
        }
      }
    }

    const isTransparent = transparentEdge / totalEdge > 0.3;

    if (isTransparent) {
      // Already transparent background — trim transparent edges
      return sharp(imageBuf).trim({ threshold: 10 }).toBuffer();
    } else {
      // White background — trim using Sharp's background-aware trim
      // This trims the uniform white border WITHOUT touching interior white pixels
      return sharp(imageBuf)
        .trim({ background: { r: 255, g: 255, b: 255 }, threshold: 30 })
        .toBuffer();
    }
  } catch {
    return imageBuf;
  }
}

// ─── Fabric warp + shade (PO-approved 2026-06-11) ────────────────────────────
/** Strength of the fabric warp+shade pass. 0 = flat paste; 0.35 = the PO-chosen default; higher =
 *  more sink-into-fabric. Scales BOTH the displacement (the print bends along broad folds) and the
 *  shading (fold detail modulates the print). LOCAL-CONTRAST NORMALIZED (PO 2026-06-11) so the
 *  effect is consistent across shirts — a smooth flat-lay's faint folds get boosted to a visible
 *  range and a heavily-wrinkled shirt's strong folds get compressed, instead of the effect riding
 *  the raw fabric (which made it invisible on smooth product mockups). */
const FABRIC_WARP_STRENGTH = 0.25; // sweet spot (PO 2026-06-16): 0.35 read vintage/dirty, 0.18 read pasted-on. 0.25 + the tightened clamp below = clean print that still contacts folds.
const WARP_GAIN = 6.0;    // shading gain on the NORMALIZED fold detail
const WARP_AMP = 45;      // max displacement (px) at strength 1.0 (follows broad folds)
const WARP_TARGET = 18;   // local-contrast normalization target (RMS of fold detail, 0-255)
const WARP_FLOOR = 10;    // min RMS before normalizing — raised (PO 2026-06-16) so a smooth flat-lay can't amplify its weave/JPEG noise into vintage speckle

/**
 * Composite a TRANSPARENT design onto a garment photo so it CONTOURS to the fabric folds instead
 * of pasting flat. Two effects, both scaled by `strength`:
 *   1. Displacement — each design pixel samples along the garment's BROAD-fold gradient (a heavily
 *      blurred luminance), so the print bends with the folds (and barely moves on a smooth shirt).
 *   2. Shading — the garment's fold DETAIL (luminance minus its local mean = a high-pass that drops
 *      the shirt's base colour/brightness), LOCAL-CONTRAST NORMALIZED to a target RMS over the print
 *      region, multiplies onto the design. The normalization is the key: it boosts a smooth chest's
 *      faint folds to a visible range and compresses a wrinkled shirt's strong folds, so the look is
 *      consistent everywhere instead of invisible on smooth product mockups.
 * Pure sharp + raw-pixel math — no system dependency, ships in the existing container. At strength 0
 * this is a plain flat composite. Exported for unit testing.
 */
export async function warpDesignOntoFabric(
  mockupBuf: Buffer,
  designBuf: Buffer,
  offsetX: number,
  offsetY: number,
  strength: number
): Promise<Buffer> {
  const { data: shirt, info } = await sharp(mockupBuf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height, CH = info.channels;
  const gray = await sharp(mockupBuf).grayscale().blur(8).raw().toBuffer();   // BROAD folds only (PO 2026-06-16: blur 1.5 multiplied the shirt's high-freq weave/JPEG noise onto the design = vintage speckle)
  const low = await sharp(mockupBuf).grayscale().blur(30).raw().toBuffer();   // local mean brightness
  const at = (buf: Buffer, x: number, y: number) =>
    buf[Math.max(0, Math.min(H - 1, y)) * W + Math.max(0, Math.min(W - 1, x))];
  const dMeta = await sharp(designBuf).metadata();
  const dw = dMeta.width!, dh = dMeta.height!;
  const design = await sharp(designBuf).ensureAlpha().raw().toBuffer();
  const out = Buffer.from(shirt);

  if (strength > 0) {
    // local-contrast normalization: RMS of the high-pass fold detail over the print box
    let s2 = 0;
    for (let j = 0; j < dh; j++) for (let i = 0; i < dw; i++) {
      const d = at(gray, offsetX + i, offsetY + j) - at(low, offsetX + i, offsetY + j);
      s2 += d * d;
    }
    const rms = Math.sqrt(s2 / (dw * dh)) || 1;
    const norm = Math.min(1.0, WARP_TARGET / Math.max(rms, WARP_FLOOR)); // cap at 1.0 (PO 2026-06-16): a smooth shirt can only ATTENUATE its noise, never amplify it
    const amp = strength * WARP_AMP;
    for (let j = 0; j < dh; j++) {
      for (let i = 0; i < dw; i++) {
        const sx = offsetX + i, sy = offsetY + j;
        if (sx < 0 || sy < 0 || sx >= W || sy >= H) continue;
        const glx = (at(low, sx + 2, sy) - at(low, sx - 2, sy)) / 255;
        const gly = (at(low, sx, sy + 2) - at(low, sx, sy - 2)) / 255;
        const di = Math.max(0, Math.min(dw - 1, Math.round(i - amp * glx)));
        const dj = Math.max(0, Math.min(dh - 1, Math.round(j - amp * gly)));
        const k = (dj * dw + di) * 4;
        const a = design[k + 3] / 255;
        if (a <= 0.01) continue;
        const detail = (at(gray, sx, sy) - at(low, sx, sy)) * norm;
        let shade = 1 + strength * WARP_GAIN * (detail / 255);
        shade = Math.max(0.72, Math.min(1.25, shade)); // ±25% swing (PO 2026-06-16): widened from ±22% so folds read but tighter than the original ±85% that bleached/dirtied the print
        const o = (sy * W + sx) * CH;
        for (let c = 0; c < 3; c++) {
          const v = Math.max(0, Math.min(255, design[k + c] * shade));
          out[o + c] = Math.round(v * a + out[o + c] * (1 - a));
        }
      }
    }
  } else {
    for (let j = 0; j < dh; j++) for (let i = 0; i < dw; i++) {
      const sx = offsetX + i, sy = offsetY + j;
      if (sx < 0 || sy < 0 || sx >= W || sy >= H) continue;
      const k = (j * dw + i) * 4, a = design[k + 3] / 255;
      if (a <= 0.01) continue;
      const o = (sy * W + sx) * CH;
      for (let c = 0; c < 3; c++) out[o + c] = Math.round(design[k + c] * a + out[o + c] * (1 - a));
    }
  }
  return sharp(out, { raw: { width: W, height: H, channels: CH } }).png().toBuffer();
}

/**
 * Composite a transparent design onto a mockup blank within the specified print zone.
 * Returns a PNG buffer of the final composite.
 *
 * Scaling strategy:
 * 1. Detect design background type (transparent, white, or full mockup)
 * 2. Trim to content bounds using Sharp's native trim (background-color aware)
 * 3. Scale trimmed design to fill the print zone (contain, aspect-ratio preserved)
 * 4. Center the design within the print zone
 */
export async function compositeDesignOnMockup(config: CompositeConfig): Promise<Buffer> {
  // 1. Download both images
  const [rawDesignBuf, mockupBuf] = await Promise.all([
    downloadImage(config.designUrl),
    downloadImage(config.mockupUrl),
  ]);

  // 1b. Check if the design is already transparent (production-ready).
  // If so, skip background removal entirely — just trim to content bounds.
  // If not transparent, run the full removal pipeline.
  const { data: edgeData, info: edgeInfo } = await sharp(rawDesignBuf)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width: ew, height: eh, channels: ec } = edgeInfo;
  const edgeSz = 20;
  let transEdge = 0, totalEdge = 0;
  for (let y = 0; y < eh; y++) {
    for (let x = 0; x < ew; x++) {
      if (x < edgeSz || x >= ew - edgeSz || y < edgeSz || y >= eh - edgeSz) {
        totalEdge++;
        if (edgeData[(y * ew + x) * ec + 3] < 30) transEdge++;
      }
    }
  }
  const isAlreadyTransparent = transEdge / totalEdge > 0.3;
  console.log(`[Compositor] Design transparent: ${isAlreadyTransparent} (${(transEdge/totalEdge*100).toFixed(1)}% transparent edges)`);

  let trimmedDesign: Buffer;
  if (isAlreadyTransparent) {
    // Production-ready transparent PNG — just trim to content bounds
    trimmedDesign = await trimDesign(rawDesignBuf);
  } else {
    // Raw image with background — run full removal pipeline
    const trimmedFirst = await trimToContent(rawDesignBuf);
    const noBgDesign = await removeBackground(trimmedFirst);
    trimmedDesign = await trimDesign(noBgDesign);
  }

  // 1c. Shirt-aware halftone + knockout (optional, gated on shirtColorHex).
  // Runs AFTER trim so we only process pixels that are part of the design itself,
  // not the trimmed-away padding. Per PO: the dot pattern lets the shirt color show
  // through the gaps, so the design integrates with the fabric instead of looking
  // like a plastic decal.
  if (config.shirtColorHex) {
    trimmedDesign = await applyShirtAwareHalftone(trimmedDesign, config.shirtColorHex);
    console.log(`[Compositor] Applied shirt-aware halftone for shirtColorHex=${config.shirtColorHex}`);
  }

  // 2. Get mockup dimensions
  const mockupMeta = await sharp(mockupBuf).metadata();
  const mockupW = mockupMeta.width!;
  const mockupH = mockupMeta.height!;

  // 3. Calculate print zone in pixels
  const zoneX = Math.round(config.printZone.x * mockupW);
  const zoneY = Math.round(config.printZone.y * mockupH);
  const zoneW = Math.round(config.printZone.width * mockupW);
  const zoneH = Math.round(config.printZone.height * mockupH);

  // 4. Get design dimensions after trim
  const designMeta = await sharp(trimmedDesign).metadata();
  const designW = designMeta.width!;
  const designH = designMeta.height!;


  // 5–6. CONTAIN-FIT the design into the print area + position WITHIN it (placeInBox).
  // The print area is the PER-TEMPLATE box the human calibrated (drawn + inch-sized) on THAT
  // color's own photo; the design is placed RELATIVE TO IT, verbatim (no reshape — the editor
  // already aspect-locked the box). Horizontal centered; vertical by anchorY (apparel "top",
  // objects "center"). placeInBox returns offsets WITHIN the box; we add the box top-left.
  const { finalW, finalH, offsetX: boxOffsetX, offsetY: boxOffsetY } =
    placeInBox(designW, designH, zoneW, zoneH, config.anchorY);


  const resizedDesign = await sharp(trimmedDesign)
    .resize(finalW, finalH, { fit: "fill", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .toBuffer();


  // DEFERRED quad/perspective warp (off by default). When config.quad is set, the future layer
  // warps resizedDesign to the 4 corner points instead of the axis-aligned placement below.
  // Not implemented yet (sharp has no native perspective op) — fall through to affine + warn,
  // never crash, so the param is safe to wire ahead of the implementation.
  if (config.quad) {
    console.warn("[Compositor] config.quad set but perspective warp is not implemented yet — using affine box placement.");
  }

  const offsetX = zoneX + boxOffsetX;  // box left + centered-within-box offset
  const offsetY = zoneY + boxOffsetY;  // box top + anchorY offset


  // 7. Warp + shade the design onto the garment so it CONTOURS to the fabric folds (PO 2026-06-11)
  // instead of pasting flat — strength FABRIC_WARP_STRENGTH. Returns a full-res PNG buffer; the
  // resize below runs in a SEPARATE Sharp instance (no lazy-pipeline reorder).
  const composited = await warpDesignOntoFabric(mockupBuf, resizedDesign, offsetX, offsetY, FABRIC_WARP_STRENGTH);

  // Resize to max 1000x1000 if larger (separate pipeline to avoid reorder)
  let outputBuf: Buffer;
  if (mockupW > 1000 || mockupH > 1000) {
    outputBuf = await sharp(composited)
      .resize(1000, 1000, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: 75, effort: 5 })
      .toBuffer();
  } else {
    outputBuf = await sharp(composited)
      .webp({ quality: 75, effort: 5 })
      .toBuffer();
  }

  return outputBuf;
}
