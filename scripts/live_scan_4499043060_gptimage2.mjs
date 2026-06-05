/**
 * Live acceptance scan: listing 4499043060 (Bigfoot dandelion shirt) in pickleball workspace.
 * Uses gpt-image-2 edit endpoint (Spike A/C pattern) — mirrors production nicheHunter.ts path.
 *
 * Reports: durable S3 URL, adaptedConcept text, pixel dimensions, per-call cost estimate.
 *
 * Run: node scripts/live_scan_4499043060_gptimage2.mjs
 */

import dotenv from "dotenv";
dotenv.config({ path: "/home/ubuntu/nyt-design-bot/.env" });

import mysql from "mysql2/promise";
import { nanoid } from "nanoid";
import { writeFileSync } from "fs";
import sharp from "sharp";

const DATABASE_URL = process.env.DATABASE_URL;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const FORGE_URL = process.env.BUILT_IN_FORGE_API_URL;
const FORGE_KEY = process.env.BUILT_IN_FORGE_API_KEY;
const SCRAPFLY_KEY = process.env.SCRAPFLY_API_KEY;

if (!OPENAI_API_KEY) { console.error("OPENAI_API_KEY not set"); process.exit(1); }

// ─── 1. Load pickleball workspace ────────────────────────────────────────────

const conn = await mysql.createConnection(DATABASE_URL);
const [wsRows] = await conn.execute(
  "SELECT id, name, slug, nicheProfile FROM workspaces WHERE slug = ?",
  ["pickleball"]
);
const ws = wsRows[0];
if (!ws) { console.error("Pickleball workspace not found"); process.exit(1); }
const nicheProfile = typeof ws.nicheProfile === "string" ? JSON.parse(ws.nicheProfile) : ws.nicheProfile;
const tvc = nicheProfile?.culturalMap?.transferableVisualConcepts ?? [];
console.log(`\n✅ Workspace: ${ws.name} (id=${ws.id})`);
console.log(`   TVCs: ${tvc.length}`);

// ─── 2. Create scan run ──────────────────────────────────────────────────────

const scanId = nanoid();
await conn.execute(
  `INSERT INTO niche_scan_runs (id, workspaceId, status, progress, createdAt) VALUES (?, ?, 'running', 0, NOW())`,
  [scanId, ws.id]
);
console.log(`\n[Scan] Created scan run: ${scanId}`);

// ─── 3. Scrape listing 4499043060 ───────────────────────────────────────────

const LISTING_URL = "https://www.etsy.com/listing/4499043060";
console.log(`\n[Step 1] Scraping ${LISTING_URL}...`);

let sourceImageUrl = null;
let sourceTitle = "Bigfoot Dandelion Shirt";
let sourceReviewCount = 137;

try {
  const resp = await fetch(
    `https://api.scrapfly.io/scrape?key=${SCRAPFLY_KEY}&url=${encodeURIComponent(LISTING_URL)}&render_js=false&country=us`,
    { signal: AbortSignal.timeout(30000) }
  );
  if (resp.ok) {
    const data = await resp.json();
    const html = data?.result?.content ?? "";
    const ogImg = html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/);
    const ogTitle = html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/);
    const reviewMatch = html.match(/(\d[\d,]+)\s+reviews?/i);
    sourceImageUrl = ogImg?.[1] ?? null;
    if (ogTitle?.[1]) sourceTitle = ogTitle[1].replace(/ \| Etsy$/, "").trim();
    if (reviewMatch?.[1]) sourceReviewCount = parseInt(reviewMatch[1].replace(/,/g, ""), 10);
    console.log(`   Title: ${sourceTitle}`);
    console.log(`   Image: ${sourceImageUrl}`);
    console.log(`   Reviews: ${sourceReviewCount}`);
  }
} catch (e) {
  console.warn(`   Scrapfly failed: ${e.message}`);
}

// Fallback
if (!sourceImageUrl) {
  sourceImageUrl = "https://i.etsystatic.com/54289425/r/il/4df21a/7981232140/il_fullxfull.7981232140_3zpt.jpg";
  console.log(`   Using fallback image: ${sourceImageUrl}`);
}

// ─── 4. Style extraction via Forge Vision LLM ───────────────────────────────

console.log(`\n[Step 1b] Extracting style...`);

let sourceStyle = null;
try {
  const styleResp = await fetch(`${FORGE_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${FORGE_KEY}` },
    body: JSON.stringify({
      messages: [{
        role: "user",
        content: [
          { type: "image_url", image_url: { url: sourceImageUrl, detail: "high" } },
          { type: "text", text: `Analyze this t-shirt design. Return JSON with these exact fields:
{
  "inkColors": ["color1","color2"],
  "inkColorNames": ["name1","name2"],
  "shirtColorRole": "negative space — shirt IS the background" or "covered by design",
  "technique": "screen-print simulation" | "DTG full-color" | "vinyl cut",
  "lineWeight": "thick bold outlines" | "hairline detail" | "no outlines",
  "shadingMethod": "halftone dots" | "crosshatch" | "flat color" | "gradient",
  "textureDetail": "heavy distress/worn" | "clean vector" | "hand-drawn organic",
  "subject": "describe the main character/creature in 5-10 words",
  "subjectCrop": "full body centered" | "bust portrait" | "close-up face",
  "composition": "centered single subject" | "badge/emblem" | "scene",
  "framingDevice": "circular badge border" | "banner ribbon" | "NONE",
  "scaleCoverage": "fills 80% of print area" | "small chest logo",
  "textPresence": "bold headline above" | "NONE",
  "textStyle": "distressed serif all-caps" | "NONE",
  "mood": "irreverent humor" | "vintage nostalgia",
  "humorMechanism": "absurdist juxtaposition" | "wordplay" | "NONE",
  "printMethod": "simulated screen-print" | "DTG" | "sublimation",
  "garmentStyle": "dark heather tee" | "natural cotton" | "black hoodie",
  "designEra": "1970s retro" | "modern minimal" | "timeless",
  "backgroundTreatment": "transparent/no background" | "shirt IS bg"
}
Return ONLY the JSON.` },
        ],
      }],
    }),
    signal: AbortSignal.timeout(60000),
  });
  if (styleResp.ok) {
    const styleData = await styleResp.json();
    const raw = styleData.choices[0].message.content;
    sourceStyle = JSON.parse(raw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim());
    console.log(`   Subject: "${sourceStyle.subject}"`);
    console.log(`   Garment: ${sourceStyle.garmentStyle}`);
  }
} catch (e) {
  console.warn(`   Style extraction failed: ${e.message}`);
}

if (!sourceStyle) {
  console.error("Style extraction failed — cannot proceed with edit_source mode");
  process.exit(1);
}

// ─── 5. deconstructAndAdapt ──────────────────────────────────────────────────

console.log(`\n[Step 3+4] Running deconstructAndAdapt...`);

const tvcBlock = tvc.length > 0
  ? `\nCULTURAL MAP — TRANSFERABLE VISUAL CONCEPTS:\n${tvc.map((c, i) => `  ${i + 1}. SOURCE: "${c.sourcePattern}" → TARGET: "${c.targetAdaptation}" (why: ${c.whyItTransfers})`).join("\n")}\n`
  : "";

const deconstructPrompt = `You are a t-shirt design strategist. Analyze this top-selling Etsy listing and adapt it for the pickleball niche.

SOURCE LISTING:
"${sourceTitle}" — ${sourceReviewCount} reviews, category: hiking, image: ${sourceImageUrl}

NICHE PROFILE:
${JSON.stringify({ summary: nicheProfile.summary, targetAudience: nicheProfile.targetAudience }, null, 2)}
${tvcBlock}

=== HARD CONSTRAINT: REPLACEMENT vs INJECTION ===
✅ REPLACEMENT (allowed): source HAS element → SWAP via cultural map
❌ INJECTION (forbidden): source does NOT have element → MUST NOT add it

Return JSON: { "patterns": [{ "patternName", "composition", "colorStrategy", "emotionalHook", "transferablePattern", "adaptedConcept" (MUST use TARGET character e.g. Llama, NOT Bigfoot), "whyItWorks", "transferValid": true, "transferReasoning" }] }`;

let pattern = null;
try {
  const deconResp = await fetch(`${FORGE_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${FORGE_KEY}` },
    body: JSON.stringify({
      messages: [{ role: "user", content: deconstructPrompt }],
      response_format: { type: "json_schema", json_schema: { name: "patterns", strict: true, schema: {
        type: "object",
        properties: { patterns: { type: "array", items: { type: "object", properties: {
          patternName: { type: "string" }, composition: { type: "string" },
          colorStrategy: { type: "string" }, emotionalHook: { type: "string" },
          transferablePattern: { type: "string" }, adaptedConcept: { type: "string" },
          whyItWorks: { type: "string" }, transferValid: { type: "boolean" },
          transferReasoning: { type: "string" },
        }, required: ["patternName","composition","colorStrategy","emotionalHook","transferablePattern","adaptedConcept","whyItWorks","transferValid","transferReasoning"], additionalProperties: false } } },
        required: ["patterns"], additionalProperties: false,
      } } },
    }),
    signal: AbortSignal.timeout(60000),
  });
  if (deconResp.ok) {
    const deconData = await deconResp.json();
    const parsed = JSON.parse(deconData.choices[0].message.content);
    pattern = parsed.patterns?.[0] ?? null;
    console.log(`   Pattern: "${pattern?.patternName}"`);
    console.log(`   adaptedConcept: "${pattern?.adaptedConcept}"`);
  }
} catch (e) {
  console.error(`   deconstructAndAdapt failed: ${e.message}`);
  process.exit(1);
}
if (!pattern) { console.error("No pattern returned"); process.exit(1); }

// ─── 6. Build minimal one-sentence prompt (mirrors production buildGenerationPayload) ─

console.log(`\n[Step 5] Building gpt-image-2 prompt...`);

const STOPWORDS = new Set(["a","an","the","and","or","of","in","on","at","to","for","with","by","from","is","it","its","as","are","was","be","this","that","have","has","had","do","does","did","not"]);
const tokenize = (text) => new Set(text.toLowerCase().split(/[\s/,\-–—.!?()]+/).filter(w => w.length > 2 && !STOPWORDS.has(w)));

const sourceTokens = tokenize(sourceStyle.subject);
let targetCharacter = "";
let bestOverlap = 0;
for (const m of tvc) {
  const patternTokens = tokenize(m.sourcePattern);
  let overlap = 0;
  Array.from(patternTokens).forEach(t => { if (sourceTokens.has(t)) overlap++; });
  if (overlap >= 2 && overlap > bestOverlap) {
    bestOverlap = overlap;
    targetCharacter = m.targetAdaptation;
  }
}

if (!targetCharacter) targetCharacter = pattern.adaptedConcept;
console.log(`   Source subject: "${sourceStyle.subject}"`);
console.log(`   Target character: "${targetCharacter}" (overlap=${bestOverlap})`);

const shirtDesc = sourceStyle.garmentStyle || "comfort color tee";
let prompt = `Instead of a ${sourceStyle.subject}, change it to a ${targetCharacter} on this ${shirtDesc}.`;
if (sourceStyle.composition && sourceStyle.composition !== "NONE") {
  prompt += ` ${sourceStyle.subjectCrop || "centered bust portrait"} composition matching the reference.`;
}
console.log(`   Prompt: "${prompt}"`);

// ─── 7. Call gpt-image-2 /images/edits ──────────────────────────────────────

console.log(`\n[Step 6] Calling gpt-image-2...`);
const t0 = Date.now();

// Download source image
const imgResp = await fetch(sourceImageUrl, { signal: AbortSignal.timeout(15000) });
if (!imgResp.ok) { console.error(`Failed to download source: ${imgResp.status}`); process.exit(1); }
const imgBuf = Buffer.from(await imgResp.arrayBuffer());

const formData = new FormData();
formData.append("model", "gpt-image-2");
formData.append("prompt", prompt);
formData.append("size", "1024x1024");
const blob = new Blob([imgBuf], { type: "image/jpeg" });
formData.append("image[]", blob, "source.jpg");

const gptResp = await fetch("https://api.openai.com/v1/images/edits", {
  method: "POST",
  headers: { "Authorization": `Bearer ${OPENAI_API_KEY}` },
  body: formData,
  signal: AbortSignal.timeout(120000),
});

const elapsed = Date.now() - t0;
console.log(`   Response time: ${elapsed}ms`);

if (!gptResp.ok) {
  const errText = await gptResp.text();
  console.error(`gpt-image-2 API error (${gptResp.status}): ${errText.substring(0, 500)}`);
  process.exit(1);
}

const gptData = await gptResp.json();
const item = gptData.data?.[0];
if (!item) { console.error("No image data in response"); process.exit(1); }

let resultBuf;
if (item.b64_json) {
  resultBuf = Buffer.from(item.b64_json, "base64");
} else if (item.url) {
  const dlResp = await fetch(item.url);
  resultBuf = Buffer.from(await dlResp.arrayBuffer());
} else {
  console.error("Response has neither b64_json nor url");
  process.exit(1);
}

// ─── 8. Measure pixel dimensions ────────────────────────────────────────────

const metadata = await sharp(resultBuf).metadata();
console.log(`   Dimensions: ${metadata.width}x${metadata.height} (${metadata.format})`);
console.log(`   File size: ${(resultBuf.length / 1024).toFixed(1)} KB`);

// DTF check: 300 DPI at 12" wide = 3600px minimum for full-width DTF
const dpi300at12in = 3600;
const dtfReady = metadata.width >= dpi300at12in;
console.log(`   DTF-ready (300DPI @ 12"): ${dtfReady ? "YES" : `NO (need ${dpi300at12in}px, got ${metadata.width}px)`}`);

// ─── 9. Upload to S3 via Forge storage proxy ────────────────────────────────

console.log(`\n[Step 7] Uploading to S3...`);

const forgeBase = FORGE_URL.endsWith("/") ? FORGE_URL : `${FORGE_URL}/`;
const uploadUrl = new URL("v1/storage/upload", forgeBase);
uploadUrl.searchParams.set("path", `generated/gpt-image-2/live_scan_${Date.now()}.png`);

const uploadForm = new FormData();
const uploadBlob = new Blob([resultBuf], { type: "image/png" });
uploadForm.append("file", uploadBlob, "result.png");

const uploadResp = await fetch(uploadUrl, {
  method: "POST",
  headers: { Authorization: `Bearer ${FORGE_KEY}` },
  body: uploadForm,
});

let previewImageUrl = null;
if (uploadResp.ok) {
  const uploadData = await uploadResp.json();
  previewImageUrl = uploadData.url;
  console.log(`   S3 URL: ${previewImageUrl}`);
} else {
  console.warn(`   S3 upload failed: ${uploadResp.status}`);
  // Save locally as fallback
  const localPath = "/home/ubuntu/webdev-static-assets/live_scan_gptimage2.png";
  writeFileSync(localPath, resultBuf);
  previewImageUrl = `LOCAL:${localPath}`;
  console.log(`   Saved locally: ${localPath}`);
}

// ─── 10. Write trend_patterns row ───────────────────────────────────────────

console.log(`\n[Step 8] Writing trend_patterns row...`);

const patternId = nanoid();
await conn.execute(
  `INSERT INTO trend_patterns
   (id, workspaceId, scanId, sourcePlatform, sourceTitle, sourceUrl, sourceImageUrl,
    sourceSales, sourceBadge, sourceScrapedAt, sourceReviewCount, sourceCategory,
    patternName, composition, colorStrategy, emotionalHook, transferablePattern,
    whyItWorks, adaptedConcept, transferValid, transferReasoning, status,
    sourceStyleJson, adaptationMode, previewImageUrl, createdAt)
   VALUES (?,?,?,?,?,?,?,?,?,NOW(),?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NOW())`,
  [
    patternId, ws.id, scanId, "etsy", sourceTitle, LISTING_URL, sourceImageUrl,
    sourceReviewCount, null, sourceReviewCount, "hiking",
    pattern.patternName, pattern.composition, pattern.colorStrategy,
    pattern.emotionalHook, pattern.transferablePattern, pattern.whyItWorks,
    pattern.adaptedConcept, pattern.transferValid ? 1 : 0, pattern.transferReasoning,
    pattern.transferValid ? "discovered" : "dismissed",
    JSON.stringify(sourceStyle), "edit_source", previewImageUrl,
  ]
);

await conn.execute(
  "UPDATE niche_scan_runs SET status='completed', progress=100, patternsFound=1, completedAt=NOW() WHERE id=?",
  [scanId]
);

// ─── 11. Read back and report ────────────────────────────────────────────────

const [rows] = await conn.execute(
  "SELECT id, sourceUrl, sourceImageUrl, previewImageUrl, adaptedConcept, adaptationMode, transferValid FROM trend_patterns WHERE id=?",
  [patternId]
);
const row = rows[0];

console.log(`\n${"═".repeat(70)}`);
console.log(`  GPT-IMAGE-2 LIVE SCAN ACCEPTANCE REPORT`);
console.log(`${"═".repeat(70)}`);
console.log(`  Pattern ID:       ${row.id}`);
console.log(`  Source URL:       ${row.sourceUrl}`);
console.log(`  Source Image:     ${row.sourceImageUrl}`);
console.log(`  Preview Image:    ${row.previewImageUrl}`);
console.log(`  adaptedConcept:   ${row.adaptedConcept}`);
console.log(`  adaptationMode:   ${row.adaptationMode}`);
console.log(`  transferValid:    ${row.transferValid}`);
console.log(`  ──────────────────────────────────────────────`);
console.log(`  Prompt used:      "${prompt}"`);
console.log(`  Target character: "${targetCharacter}"`);
console.log(`  Dimensions:       ${metadata.width}x${metadata.height}`);
console.log(`  DTF-ready:        ${dtfReady ? "YES" : "NO — needs upscale"}`);
console.log(`  API latency:      ${elapsed}ms`);
console.log(`  Cost estimate:    ~$0.080 per edit (gpt-image-2 1024x1024)`);
console.log(`${"═".repeat(70)}`);

// Verify adaptedConcept mentions llama
const mentionsLlama = row.adaptedConcept?.toLowerCase().includes("llama");
console.log(`\n  ✓ adaptedConcept mentions llama: ${mentionsLlama ? "YES ✅" : "NO ⚠️"}`);

await conn.end();
console.log("\nDone.");
