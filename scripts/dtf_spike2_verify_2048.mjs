/**
 * DTF Spike 2 Verification (2048 source): Simulates production path where
 * gpt-image-2 outputs 2048×2048, then DTF processor upscales to 3600×3600.
 * Upscale ratio: 1.76× — well within Lanczos quality range.
 */
import dotenv from "dotenv";
dotenv.config({ path: "/home/ubuntu/nyt-design-bot/.env" });
import sharp from "sharp";

const PREVIEW_URL = "https://d2xsxph8kpxj0f.cloudfront.net/310519663494566154/2UiWq4UmupNv3Rr5UypaGc/generated/gpt-image-2/live_scan_1780434000499.png";
const DTF_TARGET_PX = 3600;

console.log("Downloading preview image...");
const res = await fetch(PREVIEW_URL, { signal: AbortSignal.timeout(30000) });
const rawBuf = Buffer.from(await res.arrayBuffer());

// Simulate 2048×2048 source (upscale the 1024 to 2048 first, as if gpt-image-2 returned it)
console.log("Simulating 2048×2048 gpt-image-2 output...");
const src2048 = await sharp(rawBuf).resize(2048, 2048, { kernel: sharp.kernel.lanczos3 }).png().toBuffer();
const srcMeta = await sharp(src2048).metadata();
console.log(`Source (simulated): ${srcMeta.width}×${srcMeta.height}`);

// Now upscale from 2048 to 3600 (the actual DTF path)
const scale = DTF_TARGET_PX / Math.min(srcMeta.width, srcMeta.height);
const newWidth = Math.round(srcMeta.width * scale);
const newHeight = Math.round(srcMeta.height * scale);
console.log(`Upscaling: ${srcMeta.width}×${srcMeta.height} → ${newWidth}×${newHeight} (${scale.toFixed(3)}× Lanczos)`);

const upscaledBuf = await sharp(src2048)
  .resize(newWidth, newHeight, { kernel: sharp.kernel.lanczos3 })
  .png()
  .toBuffer();

const upMeta = await sharp(upscaledBuf).metadata();
console.log(`Upscaled: ${upMeta.width}×${upMeta.height}, ${(upscaledBuf.length / 1024 / 1024).toFixed(2)} MB`);

// Verify dimensions
const pass = upMeta.width >= DTF_TARGET_PX && upMeta.height >= DTF_TARGET_PX;
console.log(`\nDTF target (${DTF_TARGET_PX}×${DTF_TARGET_PX}): ${pass ? "✅ PASS" : "❌ FAIL"}`);
console.log(`300 DPI at 12": ${(upMeta.width / 300).toFixed(1)}" × ${(upMeta.height / 300).toFixed(1)}"`);

// Edge density (sharpness proxy)
const edgeBuf = await sharp(upscaledBuf)
  .greyscale()
  .convolve({ width: 3, height: 3, kernel: [-1, -1, -1, -1, 8, -1, -1, -1, -1] })
  .raw()
  .toBuffer({ resolveWithObject: true });

let edgeSum = 0;
for (let i = 0; i < edgeBuf.data.length; i++) edgeSum += edgeBuf.data[i];
const avgEdge = edgeSum / edgeBuf.data.length;
console.log(`Edge density (sharpness proxy): ${avgEdge.toFixed(2)} (>10 = acceptable for DTF, >15 = excellent)`);

// Compare: what does the raw 2048 look like?
const rawEdgeBuf = await sharp(src2048)
  .greyscale()
  .convolve({ width: 3, height: 3, kernel: [-1, -1, -1, -1, 8, -1, -1, -1, -1] })
  .raw()
  .toBuffer({ resolveWithObject: true });
let rawEdgeSum = 0;
for (let i = 0; i < rawEdgeBuf.data.length; i++) rawEdgeSum += rawEdgeBuf.data[i];
const rawAvgEdge = rawEdgeSum / rawEdgeBuf.data.length;
console.log(`Edge density (2048 source, no upscale): ${rawAvgEdge.toFixed(2)}`);
console.log(`Sharpness retention: ${((avgEdge / rawAvgEdge) * 100).toFixed(1)}%`);

console.log("\nDone.");
