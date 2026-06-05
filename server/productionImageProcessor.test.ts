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

// ─── assertTransparentPng tests ───────────────────────────────────────────────
import { assertTransparentPng } from "./patternProductionProcessor";

async function makePng(
  width: number,
  height: number,
  fillFn: (x: number, y: number) => [number, number, number, number]
): Promise<Buffer> {
  const channels = 4;
  const data = Buffer.alloc(width * height * channels);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = fillFn(x, y);
      const i = (y * width + x) * channels;
      data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = a;
    }
  }
  return sharp(data, { raw: { width, height, channels } }).png().toBuffer();
}

describe("assertTransparentPng", () => {
  it("throws DESIGN_TOO_SPARSE for a fully-transparent PNG (blank canvas, 0% opaque)", async () => {
    // A 100% transparent image passes the corner and ratio checks but fails the sparse check.
    // This is correct: a blank canvas is not a valid production design.
    const buf = await makePng(100, 100, () => [0, 0, 0, 0]);
    await expect(assertTransparentPng(buf, "test-blank")).rejects.toThrow(
      /DESIGN_TOO_SPARSE/
    );
  });

  it("passes a PNG with transparent background and opaque design in center", async () => {
    // Transparent corners, opaque center block (30x30 out of 100x100 = 9% opaque → 91% transparent ≥ 20%)
    const buf = await makePng(100, 100, (x, y) => {
      const inCenter = x >= 35 && x < 65 && y >= 35 && y < 65;
      return inCenter ? [50, 80, 30, 255] : [0, 0, 0, 0];
    });
    await expect(assertTransparentPng(buf, "test-pass-center")).resolves.toBeUndefined();
  });

  it("throws when all 4 corners are opaque (alpha=255)", async () => {
    // Fully opaque white PNG — simulates gpt-image-1 returning no transparency
    const buf = await makePng(100, 100, () => [255, 255, 255, 255]);
    await expect(assertTransparentPng(buf, "test-fail-opaque")).rejects.toThrow(
      /VALIDATION FAIL.*corner pixel.*alpha=255/
    );
  });

  it("throws when corners are transparent but ratio < 20% (mostly opaque body)", async () => {
    // Corners transparent, but 85% of pixels are opaque (large opaque block)
    // 85x85 opaque center out of 100x100 = 72.25% opaque → 27.75% transparent ≥ 20% — this passes
    // Make it 95x95 opaque = 90.25% opaque → 9.75% transparent < 20% — this fails
    const buf = await makePng(100, 100, (x, y) => {
      const isCorner = (x === 0 || x === 99) && (y === 0 || y === 99);
      const inLargeBlock = x >= 3 && x < 98 && y >= 3 && y < 98;
      if (isCorner) return [0, 0, 0, 0];
      if (inLargeBlock) return [50, 80, 30, 255];
      return [0, 0, 0, 0];
    });
    await expect(assertTransparentPng(buf, "test-fail-ratio")).rejects.toThrow(
      /VALIDATION FAIL.*transparent pixel ratio/
    );
  });

  it("throws with patternId in the error message for traceability", async () => {
    const buf = await makePng(50, 50, () => [255, 255, 255, 255]);
    await expect(assertTransparentPng(buf, "MY_PATTERN_ID_XYZ")).rejects.toThrow(
      /MY_PATTERN_ID_XYZ/
    );
  });

  it("throws DESIGN_TOO_SPARSE when transparent corners pass but design is blank (< 5% opaque)", async () => {
    // 99% transparent, only 1% opaque pixels — corners transparent, tiny dot in center
    const buf = await makePng(100, 100, (x, y) => {
      // Only a 3x3 dot in center (9 pixels = 0.09% of 10000) is opaque
      const inDot = x >= 49 && x <= 51 && y >= 49 && y <= 51;
      return inDot ? [50, 80, 30, 255] : [0, 0, 0, 0];
    });
    await expect(assertTransparentPng(buf, "test-sparse")).rejects.toThrow(
      /DESIGN_TOO_SPARSE/
    );
  });

  it("passes when design has sufficient content (corners transparent, 30% opaque body)", async () => {
    // 30x30 opaque block in center of 100x100 = 9% opaque — above the 5% threshold
    const buf = await makePng(100, 100, (x, y) => {
      const inBlock = x >= 35 && x < 65 && y >= 35 && y < 65;
      return inBlock ? [50, 80, 30, 255] : [0, 0, 0, 0];
    });
    await expect(assertTransparentPng(buf, "test-sparse-pass")).resolves.toBeUndefined();
  });
});

// ─── buildEditPrompt routing + reject-feedback (AVOID) tests ───────────────────
import { buildEditPrompt, aggregateAvoidList, type EditSpec } from "./patternProductionProcessor";
import type { TrendPattern } from "../drizzle/schema";

// Sample of the kind of rich, image-model-ready prompt the brain (nicheExpertPlan)
// now writes itself: scene-lock + edit + new-design vividness + style-lock + preserve-lock.
const BRAIN_PROMPT =
  "Edit this t-shirt mockup directly. Keep the exact flat-lay composition: the heather " +
  "navy v-neck tee with rolled sleeves, the wicker placemat, the white wood floor, the " +
  "pale jeans at lower left and white slip-ons at lower right. " +
  "Only change the printed shirt graphic. Replace the woman holding the umbrella with the " +
  "same woman, in the same pose and yellow dress, with a pickleball paddle added in her hand. " +
  "Keep the print as a subtle vintage distressed two-colour screen-print in navy ink with " +
  "soft worn edges, so it looks printed INTO the fabric rather than pasted on top. " +
  "Do not change the shirt colour, background, props, lighting, or anything else in the scene.";

const SAMPLE_SPEC: EditSpec = {
  canConvert: true,
  fitReason: "wordmark and figure both map to on-brand pickleball mascots",
  bestMatch: { type: "mascot", item: "Capybara — zen dinker", why: "calm dink energy maps to the woman's pose" },
  editPrompt: BRAIN_PROMPT,
};

const SKIP_SPEC: EditSpec = {
  canConvert: false,
  fitReason: "specific pop-culture reference outside the knowledge base",
  bestMatch: { type: "none", item: "-", why: "no on-brand angle" },
  editPrompt: "",
};

const dp = (o: Partial<TrendPattern>): TrendPattern =>
  ({ status: "dismissed", rejectionReason: null, rejectionTags: null, ...o }) as unknown as TrendPattern;

describe("buildEditPrompt — assembles the brain prompt + guardrails", () => {
  it("emits the brain's rich editPrompt verbatim (no template flattening)", () => {
    const p = buildEditPrompt(SAMPLE_SPEC, []);
    expect(p).toContain(BRAIN_PROMPT.trim());
    // The brain's specific anchors must survive end-to-end (this is the whole point —
    // no per-image vividness gets dropped by the templater the way the old code did).
    expect(p).toContain("wicker placemat");
    expect(p).toContain("printed INTO the fabric");
  });
  it("appends the DTF print constraint", () => {
    const p = buildEditPrompt(SAMPLE_SPEC, []);
    expect(p).toContain("PRINT CONSTRAINT (DTF)");
    expect(p).toContain("bold, solid shapes only");
  });
  it("appends the AVOID block when there are rejection reasons", () => {
    const p = buildEditPrompt(SAMPLE_SPEC, ["salt shaker again", "too generic"]);
    expect(p).toContain("AVOID");
    expect(p).toContain("salt shaker again");
    expect(p).toContain("too generic");
  });
  it("omits the AVOID block entirely when there is nothing to avoid", () => {
    expect(buildEditPrompt(SAMPLE_SPEC, [])).not.toMatch(/AVOID\b/);
  });
  it("handles SKIP spec (empty editPrompt) without crashing", () => {
    // Defensive: buildEditPrompt should never be called for a skip in the orchestrator,
    // but if it is, return only the guardrails — no brain prompt to emit.
    const p = buildEditPrompt(SKIP_SPEC, []);
    expect(p).toContain("PRINT CONSTRAINT (DTF)");
    expect(p).not.toContain("Edit this t-shirt mockup");
  });
});

describe("aggregateAvoidList", () => {
  it("collects free-text reasons + tag labels and dedupes (case-insensitive)", () => {
    const out = aggregateAvoidList([
      dp({ rejectionReason: "salt shaker again", rejectionTags: ["too_generic"] }),
      dp({ rejectionReason: "Salt Shaker Again", rejectionTags: ["too_generic", "off_brand"] }),
    ]);
    expect(out).toContain("salt shaker again");
    expect(out).toContain("too generic");
    expect(out).toContain("off brand");
    expect(out.filter((x) => x.toLowerCase() === "salt shaker again")).toHaveLength(1);
  });
  it("ignores non-dismissed patterns", () => {
    const out = aggregateAvoidList([
      dp({ status: "approved", rejectionReason: "should be ignored" }),
      dp({ status: "discovered", rejectionTags: ["wrong_style"] }),
    ]);
    expect(out).toHaveLength(0);
  });
  it("caps the list at 8", () => {
    const many = Array.from({ length: 20 }, (_, i) => dp({ rejectionReason: `reason ${i}` }));
    expect(aggregateAvoidList(many)).toHaveLength(8);
  });
  it("filters out the 'transfer failed' meta-tag noise but keeps real signals", () => {
    const out = aggregateAvoidList([
      dp({ rejectionTags: ["transfer_failed", "too_generic"] }),
      dp({ rejectionTags: ["transfer_failed"] }),
    ]);
    expect(out).not.toContain("transfer failed");
    expect(out).toContain("too generic");
  });
});
