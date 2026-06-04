/**
 * E2E acceptance test: Bigfoot-dandelion hiking source + pickleball workspace
 * → must produce "Llama blowing a dandelion" image, NOT "Bigfoot playing pickleball"
 *
 * Run: node scripts/e2e_bigfoot_to_llama.mjs
 */

import dotenv from 'dotenv';
dotenv.config({ path: '/home/ubuntu/nyt-design-bot/.env' });
import mysql from 'mysql2/promise';

const FORGE_API_URL = process.env.BUILT_IN_FORGE_API_URL;
const FORGE_API_KEY = process.env.BUILT_IN_FORGE_API_KEY;
const SCRAPFLY_API_KEY = process.env.SCRAPFLY_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL;

// ─── 1. Load pickleball workspace from DB ────────────────────────────────────

const conn = await mysql.createConnection(DATABASE_URL);
const [wsRows] = await conn.execute('SELECT id, name, nicheProfile FROM workspaces WHERE slug = ?', ['pickleball']);
const ws = wsRows[0];
if (!ws) { console.error('Pickleball workspace not found'); process.exit(1); }

const nicheProfile = typeof ws.nicheProfile === 'string' ? JSON.parse(ws.nicheProfile) : ws.nicheProfile;
const tvc = nicheProfile?.culturalMap?.transferableVisualConcepts ?? [];
console.log(`\n✅ Workspace loaded: ${ws.name}`);
console.log(`   transferableVisualConcepts: ${tvc.length} entries`);
tvc.forEach((c, i) => console.log(`   ${i+1}. "${c.sourcePattern}" → "${c.targetAdaptation}"`));

// ─── 2. Scrape the Bigfoot-dandelion listing ──────────────────────────────────

const BIGFOOT_LISTING_URL = 'https://www.etsy.com/listing/4499043060';
console.log(`\n[Step 2] Scraping ${BIGFOOT_LISTING_URL}...`);

let sourceImageUrl = null;
let sourceTitle = null;

try {
  const scrapResp = await fetch(
    `https://api.scrapfly.io/scrape?key=${SCRAPFLY_API_KEY}&url=${encodeURIComponent(BIGFOOT_LISTING_URL)}&render_js=false&country=us`,
    { signal: AbortSignal.timeout(30000) }
  );
  if (scrapResp.ok) {
    const scrapData = await scrapResp.json();
    const html = scrapData?.result?.content ?? '';
    // Extract first image URL from og:image or listing image
    const ogMatch = html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/);
    const titleMatch = html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/);
    sourceImageUrl = ogMatch?.[1] ?? null;
    sourceTitle = titleMatch?.[1] ?? 'Bigfoot dandelion shirt';
    console.log(`   Title: ${sourceTitle}`);
    console.log(`   Image: ${sourceImageUrl}`);
  }
} catch (e) {
  console.warn(`   Scrapfly failed: ${e.message} — using known image URL`);
}

// Fallback to the known image URL from prior scrape
if (!sourceImageUrl) {
  sourceImageUrl = 'https://i.etsystatic.com/54289425/r/il/4df21a/7981232140/il_fullxfull.7981232140_3zpt.jpg';
  console.log(`   Using fallback image: ${sourceImageUrl}`);
}

// ─── 3. Extract style via Vision LLM ─────────────────────────────────────────

console.log('\n[Step 3] Extracting style from source image...');

const styleResp = await fetch(`${FORGE_API_URL}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${FORGE_API_KEY}` },
  body: JSON.stringify({
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: { url: sourceImageUrl, detail: 'high' },
          },
          {
            type: 'text',
            text: `Analyze this t-shirt design image and return a JSON object with these exact fields:
{
  "artStyle": "illustrated|photographic|typographic|abstract|vintage|minimalist",
  "mood": "whimsical|serious|humorous|inspirational|nostalgic|edgy",
  "composition": "centered|scattered|diagonal|portrait|landscape",
  "primaryColors": ["#hex1", "#hex2", "#hex3"],
  "subject": "describe the main character/creature/subject in 5-10 words",
  "keyVisualElements": ["element1", "element2", "element3"],
  "overallAesthetic": "one sentence describing the complete visual style"
}
Return ONLY the JSON object.`,
          },
        ],
      },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'source_style',
        strict: true,
        schema: {
          type: 'object',
          properties: {
            artStyle: { type: 'string' },
            mood: { type: 'string' },
            composition: { type: 'string' },
            primaryColors: { type: 'array', items: { type: 'string' } },
            subject: { type: 'string' },
            keyVisualElements: { type: 'array', items: { type: 'string' } },
            overallAesthetic: { type: 'string' },
          },
          required: ['artStyle', 'mood', 'composition', 'primaryColors', 'subject', 'keyVisualElements', 'overallAesthetic'],
          additionalProperties: false,
        },
      },
    },
  }),
  signal: AbortSignal.timeout(60000),
});

const styleData = await styleResp.json();
const sourceStyle = JSON.parse(styleData.choices[0].message.content);
console.log(`   Subject: "${sourceStyle.subject}"`);
console.log(`   Art style: ${sourceStyle.artStyle}, Mood: ${sourceStyle.mood}`);
console.log(`   Colors: ${sourceStyle.primaryColors.join(', ')}`);

// ─── 4. Run the matching algorithm ───────────────────────────────────────────

console.log('\n[Step 4] Running character-swap matching algorithm...');

const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'in', 'on', 'at', 'to', 'for',
  'with', 'by', 'from', 'is', 'it', 'its', 'as', 'are', 'was', 'be',
  'this', 'that', 'have', 'has', 'had', 'do', 'does', 'did', 'not',
]);
const tokenize = (text) => new Set(
  text.toLowerCase().split(/[\s/,\-–—.!?()]+/).filter(w => w.length > 2 && !STOPWORDS.has(w))
);

const sourceTokens = tokenize(sourceStyle.subject);
console.log(`   Source tokens: [${Array.from(sourceTokens).join(', ')}]`);

let bestMatch = null;
let bestOverlap = 0;
for (const m of tvc) {
  const patternTokens = tokenize(m.sourcePattern);
  let overlap = 0;
  Array.from(patternTokens).forEach(t => { if (sourceTokens.has(t)) overlap++; });
  console.log(`   Pattern "${m.sourcePattern}" tokens: [${Array.from(patternTokens).join(', ')}] → overlap=${overlap}`);
  if (overlap >= 2 && overlap > bestOverlap) {
    bestOverlap = overlap;
    bestMatch = m;
  }
}

if (bestMatch) {
  console.log(`\n✅ CHARACTER SWAP FOUND (overlap=${bestOverlap}):`);
  console.log(`   "${sourceStyle.subject}" → "${bestMatch.targetAdaptation}"`);
} else {
  console.log('\n❌ NO CHARACTER SWAP MATCH FOUND — would fall back to adaptedConcept');
  process.exit(1);
}

// ─── 5. Build the image generation prompt ────────────────────────────────────

const styleDesc = [
  `${sourceStyle.artStyle} style`,
  `${sourceStyle.mood} mood`,
  `${sourceStyle.composition} composition`,
  `palette: ${sourceStyle.primaryColors.slice(0, 3).join(', ')}`,
].join(', ');

const swapInstruction = `SWAP the character: replace "${sourceStyle.subject}" with "${bestMatch.targetAdaptation}". Reason: ${bestMatch.whyItTransfers}`;

const prompt = [
  `Edit this t-shirt design. HARD RULES — you MUST follow ALL of these:`,
  ``,
  `=== THE ONE CHANGE ===`,
  `${swapInstruction}.`,
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
].join('\n');

console.log('\n[Step 5] Image generation prompt:');
console.log('─'.repeat(60));
console.log(prompt);
console.log('─'.repeat(60));

// ─── 6. Generate the image ────────────────────────────────────────────────────

console.log('\n[Step 6] Generating image (this takes 10-20s)...');

// Use the correct Forge ImageService endpoint (Connect protocol)
const baseUrl = FORGE_API_URL.endsWith('/') ? FORGE_API_URL : `${FORGE_API_URL}/`;
const imgEndpoint = new URL('images.v1.ImageService/GenerateImage', baseUrl).toString();

const imgResp = await fetch(imgEndpoint, {
  method: 'POST',
  headers: {
    'accept': 'application/json',
    'content-type': 'application/json',
    'connect-protocol-version': '1',
    'authorization': `Bearer ${FORGE_API_KEY}`,
  },
  body: JSON.stringify({
    prompt,
    original_images: [{ url: sourceImageUrl, mimeType: 'image/jpeg' }],
  }),
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
  console.error('No image b64Json in response:', JSON.stringify(imgData).slice(0, 300));
  process.exit(1);
}

// Save to disk for inspection
import { writeFileSync } from 'fs';
const buf = Buffer.from(b64, 'base64');
const outPath = '/home/ubuntu/webdev-static-assets/e2e_llama_dandelion.png';
writeFileSync(outPath, buf);
console.log(`   Saved to: ${outPath}`);
const generatedUrl = outPath;

console.log(`\n✅ IMAGE GENERATED:`);
console.log(`   URL: ${generatedUrl}`);
console.log(`\n=== ACCEPTANCE TEST RESULT ===`);
console.log(`Source subject: "${sourceStyle.subject}"`);
console.log(`Character swap: → "${bestMatch.targetAdaptation}"`);
console.log(`Expected output: Llama blowing a dandelion in distressed earthy style`);
console.log(`Generated image: ${generatedUrl}`);

await conn.end();
