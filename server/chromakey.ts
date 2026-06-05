/**
 * Chromakey — corner-sampled edge-connected flood-fill.
 *
 * Spike-validated 5/5 on gpt-image-2 magenta-background outputs.
 * The model produces a flat colored background (not exact #FF00FF — muted pink/magenta
 * r≈200-220, g≈60-100, b≈120-170). Corner sampling handles this variance automatically.
 *
 * Algorithm:
 * 1. Sample top-left corner pixel as reference color.
 * 2. BFS flood-fill from all edge pixels within TOLERANCE of that color → alpha=0.
 * 3. Return transparent PNG buffer.
 *
 * Edge-connected fill: interior pixels matching the BG color are preserved.
 */
import sharp from "sharp";

const FLOOD_FILL_TOLERANCE = 40;

/**
 * Remove the background from an image using corner-sampled flood-fill chromakey.
 * Returns a transparent PNG buffer.
 */
export async function chromakeyFromCorners(imageBuf: Buffer): Promise<Buffer> {
  const { data, info } = await sharp(imageBuf)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height, channels } = info;
  const output = Buffer.from(data);

  // Sample corner color (top-left)
  const refR = output[0], refG = output[1], refB = output[2];
  console.log(`[Chromakey] Corner color: r=${refR} g=${refG} b=${refB}`);

  const colorDist = (idx: number) => {
    const r = output[idx], g = output[idx + 1], b = output[idx + 2];
    return Math.sqrt((r - refR) ** 2 + (g - refG) ** 2 + (b - refB) ** 2);
  };

  const visited = new Uint8Array(width * height);
  const queue: number[] = [];

  // Seed: all edge pixels within tolerance
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (x === 0 || x === width - 1 || y === 0 || y === height - 1) {
        const idx = (y * width + x) * channels;
        if (colorDist(idx) <= FLOOD_FILL_TOLERANCE) {
          const pos = y * width + x;
          visited[pos] = 1;
          queue.push(pos);
        }
      }
    }
  }

  // BFS flood-fill
  while (queue.length > 0) {
    const pos = queue.pop()!;
    const px = pos % width;
    const py = Math.floor(pos / width);
    output[pos * channels + 3] = 0;

    const neighbors = [pos - 1, pos + 1, pos - width, pos + width];
    for (const n of neighbors) {
      if (n < 0 || n >= width * height) continue;
      const ny = Math.floor(n / width);
      const nx = n % width;
      if (Math.abs(ny - py) > 1 || Math.abs(nx - px) > 1) continue;
      if (visited[n]) continue;
      if (colorDist(n * channels) <= FLOOD_FILL_TOLERANCE) {
        visited[n] = 1;
        queue.push(n);
      }
    }
  }

  return sharp(output, { raw: { width, height, channels: channels as 4 } })
    .png()
    .toBuffer();
}
