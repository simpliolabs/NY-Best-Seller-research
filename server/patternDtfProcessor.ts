/**
 * Pattern DTF Processor — Style-Faithful Pipeline (Two-Output Pipeline)
 * Karpathy P2: one function, one purpose.
 *
 * Triggered ONLY after a pattern is approved (not at scan time).
 * Downloads the preview image, removes the white background via edge-flood-fill,
 * uploads the transparent PNG to S3, and returns the URL.
 *
 * This mirrors the logic in productionImageProcessor.ts but is scoped to
 * trend_patterns (not design_concepts). It does NOT generate a new image —
 * it processes the existing previewImageUrl.
 */
import sharp from "sharp";
import { storagePut } from "./storage";
import { nanoid } from "nanoid";

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
 * Process a pattern preview image into a DTF-ready transparent PNG.
 * Downloads the preview, removes white background, uploads to S3.
 * Returns the S3 URL of the transparent PNG, or null on failure.
 */
export async function processPatternForDtf(previewImageUrl: string): Promise<string | null> {
  try {
    const res = await fetch(previewImageUrl, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) {
      console.warn(`[PatternDtf] Failed to download preview: ${previewImageUrl} (${res.status})`);
      return null;
    }
    const rawBuf = Buffer.from(await res.arrayBuffer());

    // Remove white background
    const transparentBuf = await removeWhiteBackground(rawBuf);

    // Upload to S3
    const key = `pattern-dtf/${nanoid()}.png`;
    const { url } = await storagePut(key, transparentBuf, "image/png");
    return url;
  } catch (err) {
    console.warn("[PatternDtf] Processing failed:", err);
    return null;
  }
}
