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
// Hue test for the magenta key: red AND blue both this far above green. Brightness-independent, so it
// catches the render's VARIABLE magenta (flat ~210,80,150 corner vs brighter ~244,92,212 mesh holes).
const MAGENTA_MARGIN = 25;
// Magenta is r≈b (both ≫ g). This guard keeps the global key from eating red/orange (r≫b) or purple
// (b≫r) ART. Empirically a no-op on the real magenta net (PO's "KITCHEN IS LAVA" sample: all 37,448
// keyed px measured |r-b|<=20), but it shrinks the key's blast radius on designs with intentional
// red/skin/purple (PO 2026-06-16, bug #3 — verified against the real design before shipping).
const MAGENTA_RB_BALANCE = 60;

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

  // Global key (PO 2026-06-11): the edge-connected flood-fill leaves magenta that is fully ENCLOSED
  // by the art — a net's mesh holes, each ringed by threads — unreachable from the border, so it
  // stays opaque (the live "magenta net"). A distance-to-corner test also misses it: the holes read a
  // brighter magenta (~244,92,212) than the sampled corner (~210,80,150), ~80 away. So key by HUE —
  // any opaque pixel whose red AND blue both sit well above green IS the magenta key, at any
  // brightness. Safe for a chroma-key render: the art avoids magenta, so this is background showing
  // through (holes = shirt). Verified on the real production net: clears the mesh, leaves text/ball
  // /frame intact.
  for (let pos = 0; pos < width * height; pos++) {
    const idx = pos * channels;
    if (output[idx + 3] === 0) continue;
    const r = output[idx], g = output[idx + 1], b = output[idx + 2];
    if (r > g + MAGENTA_MARGIN && b > g + MAGENTA_MARGIN && Math.abs(r - b) <= MAGENTA_RB_BALANCE) output[idx + 3] = 0;
  }

  // Despill the magenta fringe (PO 2026-06-11). The flood-fill above is BINARY — anti-aliased art
  // edges that blend toward the magenta render background (fine net grids, thin linework) survive
  // fully opaque with magenta-contaminated RGB, showing as a bright pink fringe on the final mockup.
  // Neutralize it: for opaque pixels ON THE ALPHA BOUNDARY (adjacent to a keyed pixel) that read
  // magenta (R and B both above G, from the #FF00FF render bg), pull R and B down toward G. Gated to
  // the boundary so a design's intentional INTERIOR magenta/pink (never edge-connected to the keyed
  // background) is left untouched.
  const DESPILL_MARGIN = 12;
  const isKeyed = (p: number) => output[p * channels + 3] === 0;
  for (let pos = 0; pos < width * height; pos++) {
    const idx = pos * channels;
    if (output[idx + 3] === 0) continue; // already keyed transparent
    const r = output[idx], g = output[idx + 1], b = output[idx + 2];
    if (!(r > g && b > g)) continue; // not magenta-ish — a true colour, leave it
    const px = pos % width, py = (pos - px) / width;
    const onEdge =
      (px > 0 && isKeyed(pos - 1)) || (px < width - 1 && isKeyed(pos + 1)) ||
      (py > 0 && isKeyed(pos - width)) || (py < height - 1 && isKeyed(pos + width));
    if (!onEdge) continue;
    const cap = g + DESPILL_MARGIN;
    if (r > cap) output[idx] = cap;
    if (b > cap) output[idx + 2] = cap;
  }

  return sharp(output, { raw: { width, height, channels: channels as 4 } })
    .png()
    .toBuffer();
}
