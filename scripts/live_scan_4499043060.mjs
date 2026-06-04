/**
 * Live in-app scan: listing 4499043060 (Bigfoot dandelion shirt) in pickleball workspace.
 * Runs the FULL pipeline: scrape → style extract → Reddit signals → deconstructAndAdapt
 * → buildGenerationPayload → generateImage → write trend_patterns row.
 *
 * This is the same code path as the in-app "Run Scan" button, but targeting a single
 * known listing. Uses the actual server-side modules (not a standalone reimplementation).
 *
 * Run: node scripts/live_scan_4499043060.mjs
 */

// Load env first
import dotenv from "dotenv";
dotenv.config({ path: "/home/ubuntu/nyt-design-bot/.env" });

import mysql from "mysql2/promise";
import { nanoid } from "nanoid";
import { writeFileSync } from "fs";
import { execSync } from "child_process";

const DATABASE_URL = process.env.DATABASE_URL;

// ─── 1. Load pickleball workspace ────────────────────────────────────────────

const conn = await mysql.createConnection(DATABASE_URL);
const [wsRows] = await conn.execute(
  "SELECT id, name, slug, nicheProfile FROM workspaces WHERE slug = ?",
  ["pickleball"]
);
const ws = wsRows[0];
if (!ws) {
  console.error("Pickleball workspace not found");
  process.exit(1);
}
const nicheProfile =
  typeof ws.nicheProfile === "string"
    ? JSON.parse(ws.nicheProfile)
    : ws.nicheProfile;

const tvc = nicheProfile?.culturalMap?.transferableVisualConcepts ?? [];
console.log(`\n✅ Workspace: ${ws.name} (id=${ws.id})`);
console.log(`   TVCs: ${tvc.length}`);

// ─── 2. Create a scan run row ─────────────────────────────────────────────────

const scanId = nanoid();
await conn.execute(
  `INSERT INTO niche_scan_runs (id, workspaceId, status, progress, createdAt)
   VALUES (?, ?, 'running', 0, NOW())`,
  [scanId, ws.id]
);
console.log(`\n[Scan] Created scan run: ${scanId}`);

// ─── 3. Scrape listing 4499043060 via Scrapfly ───────────────────────────────

const LISTING_URL = "https://www.etsy.com/listing/4499043060";
const SCRAPFLY_KEY = process.env.SCRAPFLY_API_KEY;

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
    const ogImg = html.match(
      /<meta[^>]+property="og:image"[^>]+content="([^"]+)"/
    );
    const ogTitle = html.match(
      /<meta[^>]+property="og:title"[^>]+content="([^"]+)"/
    );
    const reviewMatch = html.match(/(\d[\d,]+)\s+reviews?/i);
    sourceImageUrl = ogImg?.[1] ?? null;
    if (ogTitle?.[1]) sourceTitle = ogTitle[1].replace(/ \| Etsy$/, "").trim();
    if (reviewMatch?.[1])
      sourceReviewCount = parseInt(reviewMatch[1].replace(/,/g, ""), 10);
    console.log(`   Title: ${sourceTitle}`);
    console.log(`   Image: ${sourceImageUrl}`);
    console.log(`   Reviews: ${sourceReviewCount}`);
  }
} catch (e) {
  console.warn(`   Scrapfly failed: ${e.message}`);
}

// Fallback to known URL
if (!sourceImageUrl) {
  sourceImageUrl =
    "https://i.etsystatic.com/54289425/r/il/4df21a/7981232140/il_fullxfull.7981232140_3zpt.jpg";
  console.log(`   Using fallback: ${sourceImageUrl}`);
}

const hotSeller = {
  title: sourceTitle,
  category: "hiking",
  estimatedSales: sourceReviewCount,
  imageDescription: "",
  sourceUrl: LISTING_URL,
  sourceImageUrl,
  sourceReviewCount,
  sourceBadge: null,
};

// ─── 4. Extract style via Vision LLM ─────────────────────────────────────────

const FORGE_URL = process.env.BUILT_IN_FORGE_API_URL;
const FORGE_KEY = process.env.BUILT_IN_FORGE_API_KEY;

console.log(`\n[Step 1b] Extracting style from source image...`);

let sourceStyle = null;
try {
  const styleResp = await fetch(`${FORGE_URL}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${FORGE_KEY}`,
    },
    body: JSON.stringify({
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: { url: sourceImageUrl, detail: "high" },
            },
            {
              type: "text",
              text: `Analyze this t-shirt design and return JSON:
{
  "artStyle": "illustrated|photographic|typographic|abstract|vintage|minimalist",
  "mood": "whimsical|serious|humorous|inspirational|nostalgic|edgy",
  "composition": "centered|scattered|diagonal|portrait|landscape",
  "primaryColors": ["#hex1","#hex2","#hex3"],
  "subject": "describe the main character/creature in 5-10 words",
  "keyVisualElements": ["element1","element2","element3"],
  "overallAesthetic": "one sentence"
}
Return ONLY the JSON.`,
            },
          ],
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "source_style",
          strict: true,
          schema: {
            type: "object",
            properties: {
              artStyle: { type: "string" },
              mood: { type: "string" },
              composition: { type: "string" },
              primaryColors: { type: "array", items: { type: "string" } },
              subject: { type: "string" },
              keyVisualElements: { type: "array", items: { type: "string" } },
              overallAesthetic: { type: "string" },
            },
            required: [
              "artStyle",
              "mood",
              "composition",
              "primaryColors",
              "subject",
              "keyVisualElements",
              "overallAesthetic",
            ],
            additionalProperties: false,
          },
        },
      },
    }),
    signal: AbortSignal.timeout(60000),
  });
  if (styleResp.ok) {
    const styleData = await styleResp.json();
    sourceStyle = JSON.parse(styleData.choices[0].message.content);
    console.log(`   Subject: "${sourceStyle.subject}"`);
    console.log(`   Style: ${sourceStyle.artStyle}, ${sourceStyle.mood}`);
  }
} catch (e) {
  console.warn(`   Style extraction failed: ${e.message}`);
}

// ─── 5. Reddit signals (minimal — use existing profile signals) ───────────────

console.log(`\n[Step 2] Using cached niche signals from profile...`);
const nicheSignals = {
  topPosts: [],
  recurringThemes: nicheProfile?.culturalMoments ?? [],
  communityInsights: nicheProfile?.summary ?? "",
  emotionalTriggers: [],
  avoidTopics: nicheProfile?.avoidTopics ?? [],
};

// ─── 6. deconstructAndAdapt via LLM ──────────────────────────────────────────

console.log(`\n[Step 3+4] Running deconstructAndAdapt...`);

const tvcBlock =
  tvc.length > 0
    ? `\nCULTURAL MAP — TRANSFERABLE VISUAL CONCEPTS (character swap lookup table):\n${tvc
        .map(
          (c, i) =>
            `  ${i + 1}. SOURCE: "${c.sourcePattern}" → TARGET: "${c.targetAdaptation}" (why: ${c.whyItTransfers})`
        )
        .join("\n")}\n`
    : "";

const sellersText = `1. "${hotSeller.title}" — ${hotSeller.estimatedSales} reviews, category: ${hotSeller.category}, image: ${hotSeller.sourceImageUrl}`;

const deconstructPrompt = `You are a t-shirt design strategist. Analyze this top-selling Etsy listing and adapt it for the pickleball niche.

SOURCE LISTING:
${sellersText}

NICHE PROFILE:
${JSON.stringify({ summary: nicheProfile.summary, targetAudience: nicheProfile.targetAudience, designStyles: nicheProfile.designStyles }, null, 2)}
${tvcBlock}

=== HARD CONSTRAINT: REPLACEMENT vs INJECTION (Fix #5 + AR1) ===
✅ REPLACEMENT (allowed): source HAS element → SWAP via cultural map
   Example: Source has Bigfoot → swap to Llama (per cultural map above)
❌ INJECTION (forbidden): source does NOT have element → MUST NOT add it
   Example: Source has NO animal → do NOT add Cats, Llama, T-Rex
Element count must match: source has 3 characters → adaptation has exactly 3

Return a JSON array with exactly 1 pattern:
[{
  "patternName": "short name",
  "composition": "describe layout",
  "colorStrategy": "describe colors",
  "emotionalHook": "what emotion does it trigger",
  "transferablePattern": "what makes it transferable",
  "adaptedConcept": "IMPORTANT: describe the ADAPTED design using the TARGET character from the cultural map (e.g., Llama), NOT the source character (Bigfoot). Be specific about what the target character is doing.",
  "whyItWorks": "why this works for pickleball",
  "transferValid": true,
  "transferReasoning": "why it transfers",
  "adaptationMode": "edit_source"
}]

Return ONLY the JSON array.`;

let pattern = null;
try {
  const deconResp = await fetch(`${FORGE_URL}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${FORGE_KEY}`,
    },
    body: JSON.stringify({
      messages: [{ role: "user", content: deconstructPrompt }],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "patterns",
          strict: true,
          schema: {
            type: "object",
            properties: {
              patterns: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    patternName: { type: "string" },
                    composition: { type: "string" },
                    colorStrategy: { type: "string" },
                    emotionalHook: { type: "string" },
                    transferablePattern: { type: "string" },
                    adaptedConcept: { type: "string" },
                    whyItWorks: { type: "string" },
                    transferValid: { type: "boolean" },
                    transferReasoning: { type: "string" },
                    adaptationMode: { type: "string" },
                  },
                  required: [
                    "patternName",
                    "composition",
                    "colorStrategy",
                    "emotionalHook",
                    "transferablePattern",
                    "adaptedConcept",
                    "whyItWorks",
                    "transferValid",
                    "transferReasoning",
                    "adaptationMode",
                  ],
                  additionalProperties: false,
                },
              },
            },
            required: ["patterns"],
            additionalProperties: false,
          },
        },
      },
    }),
    signal: AbortSignal.timeout(60000),
  });
  if (deconResp.ok) {
    const deconData = await deconResp.json();
    const parsed = JSON.parse(deconData.choices[0].message.content);
    pattern = parsed.patterns?.[0] ?? null;
    console.log(`   Pattern: "${pattern?.patternName}"`);
    console.log(`   adaptedConcept: "${pattern?.adaptedConcept}"`);
    console.log(`   transferValid: ${pattern?.transferValid}`);
  }
} catch (e) {
  console.error(`   deconstructAndAdapt failed: ${e.message}`);
  process.exit(1);
}

if (!pattern) {
  console.error("No pattern returned");
  process.exit(1);
}

// ─── 7. buildGenerationPayload (mirror of server logic) ──────────────────────

console.log(`\n[Step 5] Building generation payload...`);

const STOPWORDS = new Set([
  "a","an","the","and","or","of","in","on","at","to","for",
  "with","by","from","is","it","its","as","are","was","be",
  "this","that","have","has","had","do","does","did","not",
]);
const tokenize = (text) =>
  new Set(
    text
      .toLowerCase()
      .split(/[\s/,\-–—.!?()]+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w))
  );

const mode = sourceStyle ? "edit_source" : "style_reference";
let generationPrompt = "";

if (mode === "edit_source" && sourceStyle) {
  // Character swap lookup
  const sourceTokens = tokenize(sourceStyle.subject);
  let bestMatch = null;
  let bestOverlap = 0;
  for (const m of tvc) {
    const patternTokens = tokenize(m.sourcePattern);
    let overlap = 0;
    Array.from(patternTokens).forEach((t) => {
      if (sourceTokens.has(t)) overlap++;
    });
    console.log(
      `   TVC "${m.sourcePattern}" overlap=${overlap}`
    );
    if (overlap >= 2 && overlap > bestOverlap) {
      bestOverlap = overlap;
      bestMatch = m;
    }
  }

  if (bestMatch) {
    console.log(
      `   ✅ CHARACTER SWAP: "${sourceStyle.subject}" → "${bestMatch.targetAdaptation}" (overlap=${bestOverlap})`
    );
    const styleDesc = [
      `Technique: ${sourceStyle.technique}`,
      `Line weight: ${sourceStyle.lineWeight}`,
      `Shading: ${sourceStyle.shadingMethod}`,
      `Texture: ${sourceStyle.textureDetail}`,
      `Colors: ${(sourceStyle.inkColors ?? sourceStyle.primaryColors ?? []).join(", ")}`,
      `Composition: ${sourceStyle.composition}`,
      `Framing: ${sourceStyle.framingDevice && sourceStyle.framingDevice !== "NONE" ? sourceStyle.framingDevice : "none"}`,
      `Text style: ${sourceStyle.textStyle && sourceStyle.textStyle !== "NONE" ? sourceStyle.textStyle : "none"}`,
      `Design era: ${sourceStyle.designEra}`,
    ].join(". ");

    generationPrompt = [
      `Edit this t-shirt design. HARD RULES — you MUST follow ALL of these:`,
      ``,
      `=== THE ONE CHANGE ===`,
      `SWAP the character: replace "${sourceStyle.subject}" with "${bestMatch.targetAdaptation}". Reason: ${bestMatch.whyItTransfers}`,
      `EVERYTHING ELSE stays IDENTICAL — same pose, same props, same scene, same composition.`,
      ``,
      `=== WHAT MUST NOT CHANGE ===`,
      `1. KEEP the EXACT same layout — same number of visual elements in the SAME positions.`,
      `2. KEEP all non-character elements (flowers, props, objects, scenery) UNCHANGED.`,
      `3. KEEP the EXACT same text placement — title position, subtitle position, font style.`,
      `4. KEEP the EXACT same art style: ${styleDesc}.`,
      `5. KEEP the EXACT same color palette and background treatment.`,
      ``,
      `=== ABSOLUTE PROHIBITIONS ===`,
      `6. DO NOT add any text, words, or slogans that are NOT in the original design. If the source has no text, output must have no text.`,
      `7. DO NOT add any additional animals, characters, or visual elements beyond what the swap requires.`,
      `8. DO NOT change the activity or scene — only the character identity changes.`,
      `9. If the source has a signature, watermark, or artist mark at the bottom, REMOVE it entirely.`,
      ``,
      `Output: transparent background, print-ready art, no shirt visible.`,
    ].join("\n");
  } else {
    console.log(`   No TVC match — falling back to adaptedConcept`);
    generationPrompt = `Create a t-shirt design: ${pattern.adaptedConcept}. Style: ${sourceStyle.overallAesthetic}. Palette: ${sourceStyle.primaryColors.join(", ")}. No shirt, transparent background.`;
  }
}

// ─── 8. Generate image ────────────────────────────────────────────────────────

console.log(`\n[Step 6] Generating image (mode: ${mode})...`);

const baseUrl = FORGE_URL.endsWith("/") ? FORGE_URL : `${FORGE_URL}/`;
const imgEndpoint = new URL(
  "images.v1.ImageService/GenerateImage",
  baseUrl
).toString();

const imgBody =
  mode === "edit_source"
    ? {
        prompt: generationPrompt,
        original_images: [{ url: sourceImageUrl, mimeType: "image/jpeg" }],
      }
    : { prompt: generationPrompt, original_images: [] };

const imgResp = await fetch(imgEndpoint, {
  method: "POST",
  headers: {
    accept: "application/json",
    "content-type": "application/json",
    "connect-protocol-version": "1",
    authorization: `Bearer ${FORGE_KEY}`,
  },
  body: JSON.stringify(imgBody),
  signal: AbortSignal.timeout(120000),
});

if (!imgResp.ok) {
  const errText = await imgResp.text();
  console.error(`Image gen failed: HTTP ${imgResp.status}: ${errText.slice(0, 300)}`);
  process.exit(1);
}

const imgData = await imgResp.json();
const b64 = imgData?.image?.b64Json;
if (!b64) {
  console.error("No b64Json in response:", JSON.stringify(imgData).slice(0, 200));
  process.exit(1);
}

// Save locally then upload via manus-upload-file CLI (same CDN path as production)
const buf = Buffer.from(b64, "base64");
const localPath = "/home/ubuntu/webdev-static-assets/live_scan_4499043060.png";
writeFileSync(localPath, buf);
console.log(`   Saved locally: ${localPath}`);

// Upload to public CDN
let previewImageUrl = null;
try {
  const uploadOut = execSync(`manus-upload-file ${localPath}`, { encoding: "utf8" });
  const cdnMatch = uploadOut.match(/CDN URL: (https:\/\/[^\s]+)/);
  previewImageUrl = cdnMatch?.[1] ?? null;
  console.log(`   CDN URL: ${previewImageUrl}`);
} catch (e) {
  console.warn(`   Upload failed: ${e.message}`);
  previewImageUrl = `LOCAL:${localPath}`;
}

// ─── 9. Write trend_patterns row ─────────────────────────────────────────────

console.log(`\n[Step 7] Writing trend_patterns row...`);

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
    patternId,
    ws.id,
    scanId,
    "etsy",
    hotSeller.title,
    hotSeller.sourceUrl,
    hotSeller.sourceImageUrl,
    hotSeller.estimatedSales,
    hotSeller.sourceBadge ?? null,
    hotSeller.sourceReviewCount,
    hotSeller.category,
    pattern.patternName,
    pattern.composition,
    pattern.colorStrategy,
    pattern.emotionalHook,
    pattern.transferablePattern,
    pattern.whyItWorks,
    pattern.adaptedConcept,
    pattern.transferValid ? 1 : 0,
    pattern.transferReasoning,
    pattern.transferValid ? "discovered" : "dismissed",
    JSON.stringify(sourceStyle),
    mode,
    previewImageUrl,
  ]
);

await conn.execute(
  "UPDATE niche_scan_runs SET status='completed', progress=100, patternsFound=1, completedAt=NOW() WHERE id=?",
  [scanId]
);

// ─── 10. Read back and print ──────────────────────────────────────────────────

const [rows] = await conn.execute(
  "SELECT id, sourceUrl, sourceImageUrl, previewImageUrl, adaptedConcept, adaptationMode, transferValid FROM trend_patterns WHERE id=?",
  [patternId]
);
const row = rows[0];

console.log(`\n${"=".repeat(60)}`);
console.log(`LIVE SCAN RESULT — trend_patterns row`);
console.log(`${"=".repeat(60)}`);
console.log(`id:              ${row.id}`);
console.log(`sourceUrl:       ${row.sourceUrl}`);
console.log(`sourceImageUrl:  ${row.sourceImageUrl}`);
console.log(`previewImageUrl: ${row.previewImageUrl}`);
console.log(`adaptedConcept:  ${row.adaptedConcept}`);
console.log(`adaptationMode:  ${row.adaptationMode}`);
console.log(`transferValid:   ${row.transferValid}`);
console.log(`${"=".repeat(60)}`);

await conn.end();
