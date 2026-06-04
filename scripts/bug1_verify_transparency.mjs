/**
 * Bug 1 verification: confirm gpt-image-2 with background:"transparent" returns true RGBA.
 */
import dotenv from "dotenv";
dotenv.config({ path: "/home/ubuntu/nyt-design-bot/.env" });
import sharp from "sharp";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) { console.error("OPENAI_API_KEY not set"); process.exit(1); }

const SOURCE_IMAGE_URL = "https://i.etsystatic.com/54289425/r/il/4df21a/7981232140/il_fullxfull.7981232140_3zpt.jpg";
const PROMPT = "Instead of a Bigfoot blowing a dandelion puff, change it to a Llama blowing a dandelion on this dark heather tee. bust portrait composition matching the reference.";

console.log("Downloading source image...");
const imgResp = await fetch(SOURCE_IMAGE_URL, { signal: AbortSignal.timeout(15000) });
const imgBuf = Buffer.from(await imgResp.arrayBuffer());

console.log("Calling gpt-image-2 with background:transparent...");
const formData = new FormData();
formData.append("model", "gpt-image-2");
formData.append("prompt", PROMPT);
formData.append("size", "1024x1024"); // Use 1024 for speed (just testing transparency)
formData.append("background", "transparent");
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

// Analyze transparency
const meta = await sharp(resultBuf).metadata();
console.log(`\nFormat: ${meta.format}`);
console.log(`Channels: ${meta.channels}`);
console.log(`Has alpha: ${meta.hasAlpha}`);
console.log(`Dimensions: ${meta.width}x${meta.height}`);

if (!meta.hasAlpha) {
  console.log("\n❌ FAIL: No alpha channel. background:transparent not working.");
  process.exit(1);
}

// Count transparent pixels
const { data: rawData, info } = await sharp(resultBuf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const { width, height, channels } = info;
let transparentPixels = 0;
for (let i = 3; i < rawData.length; i += channels) {
  if (rawData[i] < 128) transparentPixels++;
}
const totalPixels = width * height;
const pct = (transparentPixels / totalPixels * 100).toFixed(1);
console.log(`Transparent pixels: ${transparentPixels} / ${totalPixels} (${pct}%)`);

if (transparentPixels > totalPixels * 0.1) {
  console.log(`\n✅ PASS: True RGBA with ${pct}% transparent pixels (background removed by API)`);
} else {
  console.log(`\n⚠️ PARTIAL: Has alpha channel but only ${pct}% transparent. May need flood-fill for remaining white.`);
}

// Save for visual inspection
const fs = await import("fs");
fs.writeFileSync("/tmp/bug1_transparent_test.png", resultBuf);
console.log("\nSaved to /tmp/bug1_transparent_test.png");
