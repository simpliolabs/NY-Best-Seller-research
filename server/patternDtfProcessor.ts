/**
 * Pattern DTF Processor — v2 (productionDesignUrl path)
 * Karpathy P2: one function, one purpose.
 *
 * Triggered ONLY after a pattern is approved (not at scan time).
 * Input: productionDesignUrl — already a transparent PNG from the magenta chromakey pipeline.
 * Pipeline: download → upscale to 3600×3600 (12"@300DPI) → upload to S3.
 * NO flood-fill, NO background removal — the input is already transparent.
 *
 * Legacy removeWhiteBackground kept for backward compatibility with old rows
 * that have previewImageUrl but no productionDesignUrl.
 */
import sharp from "sharp";
import { storagePut } from "./storage";
import { nanoid } from "nanoid";

/** DTF target: 12" at 300DPI = 3600px per side */
const DTF_TARGET_PX = 3600;

/**
 * Upscale image to DTF target resolution using Lanczos resampling.
 * Only upscales if the image is smaller than DTF_TARGET_PX on its shortest side.
 * Returns the upscaled buffer (or original if already large enough).
 */
async function upscaleToDtf(imageBuf: Buffer): Promise<Buffer> {
  const metadata = await sharp(imageBuf).metadata();
  const { width, height } = metadata;

  if (!width || !height) return imageBuf;

  // Already at or above DTF target — no upscale needed
  const shortSide = Math.min(width, height);
  if (shortSide >= DTF_TARGET_PX) return imageBuf;

  // Calculate scale factor to bring short side to DTF target
  const scale = DTF_TARGET_PX / shortSide;
  const newWidth = Math.round(width * scale);
  const newHeight = Math.round(height * scale);

  console.log(`[PatternDtf] Upscaling ${width}×${height} → ${newWidth}×${newHeight} (${scale.toFixed(2)}×, Lanczos)`);

  return sharp(imageBuf)
    .resize(newWidth, newHeight, { kernel: sharp.kernel.lanczos3 })
    .png()
    .toBuffer();
}

/**
 * Edge-connected flood-fill white removal.
 * Only removes white pixels reachable from the image border.
 * Preserves interior white elements (text, highlights, etc.).
 * Threshold=240: pure white only, safe for near-white design elements.
 */
async function removeWhiteBackground(imageBuf: Buffer): Promise<Buffer> {
  const { data, info } = await sharp(imageBuf)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height, channels } = info;
  const THRESHOLD = 240;
  const output = Buffer.from(data);
  const visited = new Uint8Array(width * height);
  const queue: number[] = [];

  const isWhite = (idx: number) =>
    output[idx] > THRESHOLD && output[idx + 1] > THRESHOLD && output[idx + 2] > THRESHOLD;

  // Seed from all edge pixels that are pure white
  for (let x = 0; x < width; x++) {
    const topPx = x;
    const botPx = (height - 1) * width + x;
    if (isWhite(topPx * channels) && !visited[topPx]) { visited[topPx] = 1; queue.push(topPx); }
    if (isWhite(botPx * channels) && !visited[botPx]) { visited[botPx] = 1; queue.push(botPx); }
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
    output[px * channels + 3] = 0; // Set alpha to 0 (transparent)
    const x = px % width;
    const y = Math.floor(px / width);
    const neighbors = [
      y > 0 ? px - width : -1,
      y < height - 1 ? px + width : -1,
      x > 0 ? px - 1 : -1,
      x < width - 1 ? px + 1 : -1,
    ];
    for (const n of neighbors) {
      if (n >= 0 && !visited[n] && isWhite(n * channels)) {
        visited[n] = 1;
        queue.push(n);
      }
    }
  }

  return sharp(output, { raw: { width, height, channels } })
    .png()
    .toBuffer();
}

/**
 * Process a production design PNG into a DTF-ready transparent PNG.
 *
 * v2 path (productionDesignUrl): input is already transparent — just upscale.
 * Legacy path (previewImageUrl, no productionDesignUrl): run white flood-fill first.
 *
 * @param designUrl - URL of the transparent PNG (productionDesignUrl) or raw preview
 * @param isAlreadyTransparent - true when called with productionDesignUrl (skip flood-fill)
 */
export async function processPatternForDtf(
  designUrl: string,
  isAlreadyTransparent = false
): Promise<string | null> {
  try {
    const res = await fetch(designUrl, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) {
      console.warn(`[PatternDtf] Failed to download design: ${designUrl} (${res.status})`);
      return null;
    }
    const rawBuf = Buffer.from(await res.arrayBuffer());

    // Step 1: Upscale to DTF resolution (3600px target)
    const upscaledBuf = await upscaleToDtf(rawBuf);

    // Step 2: Background removal — skip if already transparent
    let transparentBuf: Buffer;
    if (isAlreadyTransparent) {
      // v2 path: productionDesignUrl is already a transparent PNG from magenta chromakey
      console.log(`[PatternDtf] v2 path — skipping flood-fill (input is transparent PNG)`);
      transparentBuf = upscaledBuf;
    } else {
      // Legacy path: opaque image (old previewImageUrl) needs white background removal
      const upscaledMeta = await sharp(upscaledBuf).metadata();
      if (upscaledMeta.hasAlpha) {
        console.log(`[PatternDtf] Input has alpha channel — skipping flood-fill`);
        transparentBuf = upscaledBuf;
      } else {
        transparentBuf = await removeWhiteBackground(upscaledBuf);
      }
    }

    // Upload to S3
    const key = `pattern-dtf/${nanoid()}.png`;
    const { url } = await storagePut(key, transparentBuf, "image/png");

    const finalMeta = await sharp(transparentBuf).metadata();
    console.log(`[PatternDtf] DTF export complete: ${finalMeta.width}×${finalMeta.height}, ${(transparentBuf.length / 1024 / 1024).toFixed(2)} MB → ${url}`);

    return url;
  } catch (err) {
    console.warn("[PatternDtf] Processing failed:", err);
    return null;
  }
}
