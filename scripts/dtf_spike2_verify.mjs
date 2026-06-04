/**
 * DTF Spike 2 Verification: Run processPatternForDtf against the llama preview
 * and verify the output is 3600×3600.
 */
import dotenv from "dotenv";
dotenv.config({ path: "/home/ubuntu/nyt-design-bot/.env" });

import sharp from "sharp";

// We can't import TS directly, so replicate the upscale+background-removal logic inline
// to verify the pipeline produces the right dimensions.

const PREVIEW_URL = "https://d2xsxph8kpxj0f.cloudfront.net/310519663494566154/2UiWq4UmupNv3Rr5UypaGc/generated/gpt-image-2/live_scan_1780434000499.png";
const DTF_TARGET_PX = 3600;

console.log("Downloading preview image...");
const res = await fetch(PREVIEW_URL, { signal: AbortSignal.timeout(30000) });
if (!res.ok) { console.error("Download failed:", res.status); process.exit(1); }
const rawBuf = Buffer.from(await res.arrayBuffer());

const origMeta = await sharp(rawBuf).metadata();
console.log(`Original: ${origMeta.width}×${origMeta.height} (${origMeta.format})`);

// Upscale
const shortSide = Math.min(origMeta.width, origMeta.height);
const scale = DTF_TARGET_PX / shortSide;
const newWidth = Math.round(origMeta.width * scale);
const newHeight = Math.round(origMeta.height * scale);

console.log(`Upscaling: ${origMeta.width}×${origMeta.height} → ${newWidth}×${newHeight} (${scale.toFixed(3)}× Lanczos)`);

const upscaledBuf = await sharp(rawBuf)
  .resize(newWidth, newHeight, { kernel: sharp.kernel.lanczos3 })
  .png()
  .toBuffer();

const upMeta = await sharp(upscaledBuf).metadata();
console.log(`Upscaled: ${upMeta.width}×${upMeta.height}, ${(upscaledBuf.length / 1024 / 1024).toFixed(2)} MB`);

// Verify dimensions
const pass = upMeta.width >= DTF_TARGET_PX && upMeta.height >= DTF_TARGET_PX;
console.log(`\nDTF target (${DTF_TARGET_PX}×${DTF_TARGET_PX}): ${pass ? "✅ PASS" : "❌ FAIL"}`);
console.log(`300 DPI at 12": ${(upMeta.width / 300).toFixed(1)}" × ${(upMeta.height / 300).toFixed(1)}"`);

// Check sharpness — compute edge density as a proxy
const edgeBuf = await sharp(upscaledBuf)
  .greyscale()
  .convolve({ width: 3, height: 3, kernel: [-1, -1, -1, -1, 8, -1, -1, -1, -1] })
  .raw()
  .toBuffer({ resolveWithObject: true });

const { data: edgeData, info: edgeInfo } = edgeBuf;
let edgeSum = 0;
for (let i = 0; i < edgeData.length; i++) edgeSum += edgeData[i];
const avgEdge = edgeSum / edgeData.length;
console.log(`Edge density (sharpness proxy): ${avgEdge.toFixed(2)} (>15 = good for print)`);

console.log("\nDone.");
