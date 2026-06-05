/**
 * Bug 1 fix test: Modify prompt to request design on white background.
 * This should produce output where flood-fill white removal works correctly.
 */
import dotenv from "dotenv";
dotenv.config({ path: "/home/ubuntu/nyt-design-bot/.env" });
import sharp from "sharp";
import fs from "fs";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) { console.error("OPENAI_API_KEY not set"); process.exit(1); }

const SOURCE_IMAGE_URL = "https://i.etsystatic.com/54289425/r/il/4df21a/7981232140/il_fullxfull.7981232140_3zpt.jpg";

// Modified prompt: request design on white background for clean extraction
const PROMPT = "Instead of a Bigfoot blowing a dandelion puff, change it to a Llama blowing a dandelion. Output the design artwork only on a plain white background, not on a shirt.";

console.log("Downloading source image...");
const imgResp = await fetch(SOURCE_IMAGE_URL, { signal: AbortSignal.timeout(15000) });
const imgBuf = Buffer.from(await imgResp.arrayBuffer());

console.log("Calling gpt-image-2 with white-background prompt...");
const formData = new FormData();
formData.append("model", "gpt-image-2");
formData.append("prompt", PROMPT);
formData.append("size", "1024x1024");
const blob = new Blob([imgBuf], { type: "image/jpeg" });
formData.append("image[]", blob, "source.jpg");

const t0 = Date.now();
const resp = await fetch("https://api.openai.com/v1/images/edits", {
  method: "POST",
  headers: { "Authorization": `Bearer ${OPENAI_API_KEY}` },
  body: formData,
  signal: AbortSignal.timeout(180000),
});

if (!resp.ok) {
  const errText = await resp.text();
  console.error(`API error: ${resp.status} ${errText.substring(0, 300)}`);
  process.exit(1);
}

const data = await resp.json();
const item = data.data?.[0];
let resultBuf;
if (item?.b64_json) resultBuf = Buffer.from(item.b64_json, "base64");
else if (item?.url) { const dl = await fetch(item.url); resultBuf = Buffer.from(await dl.arrayBuffer()); }

const elapsed = Date.now() - t0;
console.log(`Latency: ${(elapsed/1000).toFixed(1)}s`);

// Analyze
const { data: rawData, info } = await sharp(resultBuf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const { width, height, channels } = info;

// Count white edge pixels
let whiteEdge = 0, totalEdge = 0;
const THRESHOLD = 220;
for (let x = 0; x < width; x++) {
  for (const y of [0, 1, 2, height-3, height-2, height-1]) {
    const idx = (y * width + x) * channels;
    totalEdge++;
    if (rawData[idx] > THRESHOLD && rawData[idx+1] > THRESHOLD && rawData[idx+2] > THRESHOLD) whiteEdge++;
  }
}
for (let y = 3; y < height-3; y++) {
  for (const x of [0, 1, 2, width-3, width-2, width-1]) {
    const idx = (y * width + x) * channels;
    totalEdge++;
    if (rawData[idx] > THRESHOLD && rawData[idx+1] > THRESHOLD && rawData[idx+2] > THRESHOLD) whiteEdge++;
  }
}

const whiteEdgeRatio = whiteEdge / totalEdge;
console.log(`\nWhite edge ratio: ${(whiteEdgeRatio * 100).toFixed(1)}% (need >30% for flood-fill to trigger)`);

if (whiteEdgeRatio > 0.3) {
  console.log("✅ PASS: White background detected — flood-fill will work correctly");
} else {
  console.log("❌ FAIL: Background is not white enough for flood-fill");
  // Sample corners
  let rSum=0, gSum=0, bSum=0, count=0;
  for (let y = 0; y < 20; y++) {
    for (let x = 0; x < 20; x++) {
      const idx = (y * width + x) * channels;
      rSum += rawData[idx]; gSum += rawData[idx+1]; bSum += rawData[idx+2];
      count++;
    }
  }
  console.log(`  Top-left corner avg: R=${Math.round(rSum/count)} G=${Math.round(gSum/count)} B=${Math.round(bSum/count)}`);
}

fs.writeFileSync("/tmp/bug1_white_bg_test.png", resultBuf);
console.log("Saved to /tmp/bug1_white_bg_test.png");
