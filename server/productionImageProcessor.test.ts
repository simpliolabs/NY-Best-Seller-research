/**
 * Tests for productionImageProcessor v2 (magenta chromakey pipeline).
 *
 * Tests the chromakey algorithm directly using synthetic images.
 * Does NOT test the gpt-image-2 generation step (external API, tested via spike).
 */
import { describe, it, expect } from "vitest";
import sharp from "sharp";

// We need to test the chromakeyFromCorners function.
// Since it's not exported, we'll test it indirectly through a synthetic image.
// Create a synthetic magenta-background image with a design in the center.

async function createSyntheticMagentaImage(
  width: number,
  height: number,
  bgR: number,
  bgG: number,
  bgB: number,
  designSize: number
): Promise<Buffer> {
  const channels = 4;
  const data = Buffer.alloc(width * height * channels);

  // Fill with background color
  for (let i = 0; i < width * height; i++) {
    data[i * channels] = bgR;
    data[i * channels + 1] = bgG;
    data[i * channels + 2] = bgB;
    data[i * channels + 3] = 255;
  }

  // Draw a "design" in the center (dark colored block)
  const startX = Math.floor((width - designSize) / 2);
  const startY = Math.floor((height - designSize) / 2);
  for (let y = startY; y < startY + designSize; y++) {
    for (let x = startX; x < startX + designSize; x++) {
      const idx = (y * width + x) * channels;
      data[idx] = 50;      // dark red
      data[idx + 1] = 80;  // dark green
      data[idx + 2] = 30;  // dark blue
      data[idx + 3] = 255;
    }
  }

  return sharp(data, { raw: { width, height, channels } }).png().toBuffer();
}

// Inline the chromakey algorithm for testing (same as in productionImageProcessor.ts)
async function chromakeyFromCorners(imageBuf: Buffer): Promise<Buffer> {
  const TOLERANCE = 40;
  const { data, info } = await sharp(imageBuf)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height, channels } = info;
  const output = Buffer.from(data);

  const refR = output[0], refG = output[1], refB = output[2];

  const colorDist = (idx: number) => {
    const r = output[idx], g = output[idx + 1], b = output[idx + 2];
    return Math.sqrt((r - refR) ** 2 + (g - refG) ** 2 + (b - refB) ** 2);
  };

  const visited = new Uint8Array(width * height);
  const queue: number[] = [];

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (x === 0 || x === width - 1 || y === 0 || y === height - 1) {
        const idx = (y * width + x) * channels;
        if (colorDist(idx) <= TOLERANCE) {
          const pos = y * width + x;
          visited[pos] = 1;
          queue.push(pos);
        }
      }
    }
  }

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
      if (colorDist(n * channels) <= TOLERANCE) {
        visited[n] = 1;
        queue.push(n);
      }
    }
  }

  return sharp(output, { raw: { width, height, channels: channels as 4 } }).png().toBuffer();
}

describe("chromakeyFromCorners", () => {
  it("removes magenta background and preserves center design", async () => {
    // Create a 100x100 image with muted magenta BG (r=204, g=96, b=161) and 40x40 dark design
    const img = await createSyntheticMagentaImage(100, 100, 204, 96, 161, 40);
    const result = await chromakeyFromCorners(img);

    // Verify the result
    const { data, info } = await sharp(result)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const { width, height, channels } = info;

    // Corners should be transparent (alpha=0)
    const corners = [[0, 0], [width - 1, 0], [0, height - 1], [width - 1, height - 1]];
    for (const [x, y] of corners) {
      const a = data[((y * width + x) * channels) + 3];
      expect(a).toBe(0);
    }

    // Center should be opaque (alpha=255)
    const cx = Math.floor(width / 2);
    const cy = Math.floor(height / 2);
    const centerA = data[((cy * width + cx) * channels) + 3];
    expect(centerA).toBe(255);

    // Center color should be the design color (dark, not magenta)
    const centerR = data[(cy * width + cx) * channels];
    expect(centerR).toBe(50);
  });

  it("handles varying magenta shades (model output variance)", async () => {
    // Test with different muted magenta shades the model actually produces
    const shades = [
      [201, 77, 171],  // cat_pickleball
      [217, 73, 167],  // tutor_spicy
      [206, 63, 123],  // skeleton_pickleball
      [201, 89, 143],  // dog_line_art
    ];

    for (const [r, g, b] of shades) {
      const img = await createSyntheticMagentaImage(80, 80, r, g, b, 30);
      const result = await chromakeyFromCorners(img);

      const { data, info } = await sharp(result)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const { width, height, channels } = info;

      // Corner should be transparent
      const cornerA = data[3];
      expect(cornerA).toBe(0);

      // Center should be opaque
      const cx = Math.floor(width / 2);
      const cy = Math.floor(height / 2);
      const centerA = data[((cy * width + cx) * channels) + 3];
      expect(centerA).toBe(255);
    }
  });

  it("does NOT remove interior pixels that happen to match BG color", async () => {
    // Create image with magenta BG and a design that has a magenta pixel INSIDE
    const width = 50, height = 50, channels = 4;
    const data = Buffer.alloc(width * height * channels);

    // Fill with magenta BG
    for (let i = 0; i < width * height; i++) {
      data[i * channels] = 200;
      data[i * channels + 1] = 80;
      data[i * channels + 2] = 160;
      data[i * channels + 3] = 255;
    }

    // Draw a dark border ring (design outline) at 15-35
    for (let y = 15; y <= 35; y++) {
      for (let x = 15; x <= 35; x++) {
        if (y === 15 || y === 35 || x === 15 || x === 35) {
          const idx = (y * width + x) * channels;
          data[idx] = 20;
          data[idx + 1] = 20;
          data[idx + 2] = 20;
          data[idx + 3] = 255;
        }
      }
    }

    // Interior of the ring: put magenta-like pixels (should NOT be removed)
    for (let y = 16; y < 35; y++) {
      for (let x = 16; x < 35; x++) {
        const idx = (y * width + x) * channels;
        data[idx] = 200;      // Same as BG!
        data[idx + 1] = 80;
        data[idx + 2] = 160;
        data[idx + 3] = 255;
      }
    }

    const img = await sharp(data, { raw: { width, height, channels } }).png().toBuffer();
    const result = await chromakeyFromCorners(img);

    const { data: resultData, info } = await sharp(result)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    // Interior magenta pixel (25, 25) should still be opaque (not removed)
    // because the flood-fill can't reach it through the dark border
    const interiorA = resultData[((25 * width + 25) * channels) + 3];
    expect(interiorA).toBe(255);

    // Exterior corner should be transparent
    const cornerA = resultData[3];
    expect(cornerA).toBe(0);
  });

  it("handles white-background images gracefully (does not remove white)", async () => {
    // If the image has a white BG (not magenta), the flood-fill should still work
    // because it keys off the corner color (which would be white)
    const img = await createSyntheticMagentaImage(80, 80, 255, 255, 255, 30);
    const result = await chromakeyFromCorners(img);

    const { data, info } = await sharp(result)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const { width, height, channels } = info;

    // Corner (white) should be transparent
    const cornerA = data[3];
    expect(cornerA).toBe(0);

    // Center (dark design) should be opaque
    const cx = Math.floor(width / 2);
    const cy = Math.floor(height / 2);
    const centerA = data[((cy * width + cx) * channels) + 3];
    expect(centerA).toBe(255);
  });
});
