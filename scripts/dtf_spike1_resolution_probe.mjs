/**
 * DTF Spike 1: Probe gpt-image-2 for native high-resolution output.
 * Tests: size "2048x2048", "4096x4096", "auto"; quality "hd"
 * 
 * Reports response status + actual output dimensions for each variant.
 * Uses the same Bigfoot dandelion source image from the acceptance scan.
 *
 * Run: node scripts/dtf_spike1_resolution_probe.mjs
 */

import dotenv from "dotenv";
dotenv.config({ path: "/home/ubuntu/nyt-design-bot/.env" });

import sharp from "sharp";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) { console.error("OPENAI_API_KEY not set"); process.exit(1); }

const SOURCE_IMAGE_URL = "https://i.etsystatic.com/54289425/r/il/4df21a/7981232140/il_fullxfull.7981232140_3zpt.jpg";
const PROMPT = "Instead of a Bigfoot blowing a dandelion puff, change it to a Llama blowing a dandelion on this dark heather tee. bust portrait composition matching the reference.";

// Download source image once
console.log("Downloading source image...");
const imgResp = await fetch(SOURCE_IMAGE_URL, { signal: AbortSignal.timeout(15000) });
if (!imgResp.ok) { console.error(`Failed to download source: ${imgResp.status}`); process.exit(1); }
const imgBuf = Buffer.from(await imgResp.arrayBuffer());
console.log(`Source image: ${imgBuf.length} bytes\n`);

// Test variants
const variants = [
  { label: "size=2048x2048", params: { size: "2048x2048" } },
  { label: "size=4096x4096", params: { size: "4096x4096" } },
  { label: "size=auto", params: { size: "auto" } },
  { label: "quality=hd, size=1024x1024", params: { size: "1024x1024", quality: "hd" } },
  { label: "quality=hd, size=2048x2048", params: { size: "2048x2048", quality: "hd" } },
];

const results = [];

for (const variant of variants) {
  console.log(`\n${"─".repeat(60)}`);
  console.log(`Testing: ${variant.label}`);
  console.log(`${"─".repeat(60)}`);

  const formData = new FormData();
  formData.append("model", "gpt-image-2");
  formData.append("prompt", PROMPT);
  
  // Apply variant params
  for (const [key, value] of Object.entries(variant.params)) {
    formData.append(key, value);
  }
  
  const blob = new Blob([imgBuf], { type: "image/jpeg" });
  formData.append("image[]", blob, "source.jpg");

  const t0 = Date.now();
  try {
    const resp = await fetch("https://api.openai.com/v1/images/edits", {
      method: "POST",
      headers: { "Authorization": `Bearer ${OPENAI_API_KEY}` },
      body: formData,
      signal: AbortSignal.timeout(180000),
    });

    const elapsed = Date.now() - t0;
    
    if (!resp.ok) {
      const errText = await resp.text();
      console.log(`  Status: ${resp.status} ${resp.statusText}`);
      console.log(`  Error: ${errText.substring(0, 300)}`);
      results.push({ label: variant.label, status: resp.status, error: errText.substring(0, 200), width: null, height: null, elapsed });
      continue;
    }

    const data = await resp.json();
    const item = data.data?.[0];
    
    let resultBuf;
    if (item?.b64_json) {
      resultBuf = Buffer.from(item.b64_json, "base64");
    } else if (item?.url) {
      const dlResp = await fetch(item.url);
      resultBuf = Buffer.from(await dlResp.arrayBuffer());
    } else {
      console.log(`  Status: 200 but no image data`);
      results.push({ label: variant.label, status: 200, error: "no image data", width: null, height: null, elapsed });
      continue;
    }

    const metadata = await sharp(resultBuf).metadata();
    console.log(`  Status: 200 OK`);
    console.log(`  Dimensions: ${metadata.width}x${metadata.height}`);
    console.log(`  Format: ${metadata.format}`);
    console.log(`  File size: ${(resultBuf.length / 1024).toFixed(1)} KB`);
    console.log(`  Latency: ${elapsed}ms`);
    
    results.push({ label: variant.label, status: 200, error: null, width: metadata.width, height: metadata.height, elapsed, sizeKB: (resultBuf.length / 1024).toFixed(1) });
  } catch (e) {
    const elapsed = Date.now() - t0;
    console.log(`  Error: ${e.message}`);
    results.push({ label: variant.label, status: "timeout/error", error: e.message.substring(0, 200), width: null, height: null, elapsed });
  }
}

// Summary table
console.log(`\n\n${"═".repeat(70)}`);
console.log("  DTF SPIKE 1 — RESOLUTION PROBE RESULTS");
console.log(`${"═".repeat(70)}`);
console.log(`  ${"Variant".padEnd(35)} ${"Status".padEnd(8)} ${"Dimensions".padEnd(12)} ${"Latency".padEnd(10)} Size`);
console.log(`  ${"─".repeat(65)}`);
for (const r of results) {
  const dims = r.width ? `${r.width}x${r.height}` : "N/A";
  const lat = r.elapsed ? `${(r.elapsed/1000).toFixed(1)}s` : "N/A";
  const size = r.sizeKB ? `${r.sizeKB}KB` : "";
  const status = r.error ? `${r.status} ✗` : `${r.status} ✓`;
  console.log(`  ${r.label.padEnd(35)} ${status.padEnd(8)} ${dims.padEnd(12)} ${lat.padEnd(10)} ${size}`);
}
console.log(`${"═".repeat(70)}`);

// Conclusion
const anyHighRes = results.some(r => r.width && r.width > 1024);
if (anyHighRes) {
  const best = results.filter(r => r.width && r.width > 1024).sort((a, b) => b.width - a.width)[0];
  console.log(`\n✅ NATIVE HIGH-RES AVAILABLE: ${best.width}x${best.height} via "${best.label}"`);
  console.log(`   → Can skip AI upscaler for DTF if ${best.width} >= 3600`);
} else {
  console.log(`\n❌ NO NATIVE HIGH-RES: all successful responses returned 1024x1024`);
  console.log(`   → AI upscaler needed for DTF export (target 3600x3600)`);
}

console.log("\nDone.");
