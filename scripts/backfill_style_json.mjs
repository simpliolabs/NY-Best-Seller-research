/**
 * Backfill script: re-run the 20-field style extraction on all trend_patterns rows
 * where sourceStyleJson is present but lineWeight IS NULL (legacy 7-field schema).
 *
 * Success criterion:
 *   SELECT COUNT(*) WHERE sourceStyleJson IS NOT NULL
 *     AND JSON_EXTRACT(sourceStyleJson, '$.lineWeight') IS NULL = 0
 *
 * Run: node scripts/backfill_style_json.mjs
 */
import dotenv from "dotenv";
dotenv.config({ path: "/home/ubuntu/nyt-design-bot/.env" });
import mysql from "mysql2/promise";

const FORGE_URL = process.env.BUILT_IN_FORGE_API_URL;
const FORGE_KEY = process.env.BUILT_IN_FORGE_API_KEY;
const DB_URL = process.env.DATABASE_URL;

if (!FORGE_URL || !FORGE_KEY || !DB_URL) {
  console.error("Missing required env vars");
  process.exit(1);
}

// ─── 20-field style extraction (mirrors styleExtractor.ts exactly) ────────────

async function extractStyle(imageUrl) {
  const resp = await fetch(`${FORGE_URL}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${FORGE_KEY}`,
    },
    body: JSON.stringify({
      messages: [
        {
          role: "system",
          content: `You are a print-on-demand design expert who analyzes t-shirt product photos.
Your job is to extract the REPRODUCIBLE VISUAL STYLE of the printed graphic — not the shirt itself.
Focus on attributes that a designer could use to recreate the same style for a different subject.
Be precise and specific. Use concrete terms, not vague adjectives.
Return ONLY valid JSON matching the exact schema provided.`,
        },
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: imageUrl, detail: "high" } },
            {
              type: "text",
              text: `Analyze the printed graphic design on this t-shirt product photo.
Extract the visual style into the following JSON structure.
Focus ONLY on the printed artwork — ignore the garment color, background, and props.

Return this exact JSON:
{
  "inkColors": ["list of actual ink colors used in the design, e.g. black, white, rust orange"],
  "inkColorNames": ["descriptive names for each ink color, e.g. matte black, distressed rust"],
  "shirtColorRole": "how the shirt color functions: 'negative space — shirt IS the background' OR 'covered by design'",
  "technique": "one of: screen-print simulation, DTG full-color, vinyl cut, embroidery simulation, watercolor wash",
  "lineWeight": "one of: thick bold outlines, medium outlines, hairline detail, no outlines",
  "shadingMethod": "one of: halftone dots, crosshatch, flat color, gradient, stippling, NONE",
  "textureDetail": "one of: heavy distress/worn, light distress, clean vector, hand-drawn organic, rough brush",
  "subject": "describe the main subject in 3-8 words, e.g. skeleton holding fishing rod",
  "subjectCrop": "one of: full body centered, bust portrait, close-up face, object only, scene/landscape",
  "composition": "one of: centered single subject, badge/emblem, left chest logo, full-back scene, stacked text, text-dominant",
  "framingDevice": "one of: circular badge border, banner ribbon, rectangular frame, arc text, NONE",
  "scaleCoverage": "how much of the print area the design fills, e.g. fills 80% of print area, small chest logo, full-chest",
  "textPresence": "describe text placement and style, e.g. bold headline above subject, subtext below, OR NONE",
  "textStyle": "one of: distressed serif all-caps, hand-lettered script, bold sans-serif, retro block letters, NONE",
  "mood": "one of: irreverent humor, vintage nostalgia, aggressive/bold, wholesome/cute, dark/edgy, inspirational",
  "humorMechanism": "one of: absurdist juxtaposition, wordplay/pun, self-deprecating, inside joke, NONE",
  "printMethod": "one of: simulated screen-print, DTG full-color, sublimation, embroidery, vinyl",
  "garmentStyle": "describe the shirt visible in the photo, e.g. dark heather tee, natural cotton, black hoodie",
  "designEra": "one of: 1970s retro, 1980s neon, 1990s grunge, vintage americana, modern minimal, timeless/classic",
  "backgroundTreatment": "one of: transparent/no background, white rectangle, shirt IS background, colored panel"
}`,
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
              inkColors: { type: "array", items: { type: "string" } },
              inkColorNames: { type: "array", items: { type: "string" } },
              shirtColorRole: { type: "string" },
              technique: { type: "string" },
              lineWeight: { type: "string" },
              shadingMethod: { type: "string" },
              textureDetail: { type: "string" },
              subject: { type: "string" },
              subjectCrop: { type: "string" },
              composition: { type: "string" },
              framingDevice: { type: "string" },
              scaleCoverage: { type: "string" },
              textPresence: { type: "string" },
              textStyle: { type: "string" },
              mood: { type: "string" },
              humorMechanism: { type: "string" },
              printMethod: { type: "string" },
              garmentStyle: { type: "string" },
              designEra: { type: "string" },
              backgroundTreatment: { type: "string" },
            },
            required: [
              "inkColors", "inkColorNames", "shirtColorRole", "technique", "lineWeight",
              "shadingMethod", "textureDetail", "subject", "subjectCrop", "composition",
              "framingDevice", "scaleCoverage", "textPresence", "textStyle", "mood",
              "humorMechanism", "printMethod", "garmentStyle", "designEra", "backgroundTreatment",
            ],
            additionalProperties: false,
          },
        },
      },
    }),
    signal: AbortSignal.timeout(30000),
  });

  if (!resp.ok) {
    throw new Error(`LLM ${resp.status}: ${await resp.text()}`);
  }
  const data = await resp.json();
  const raw = data.choices?.[0]?.message?.content;
  if (!raw) throw new Error("Empty LLM response");
  return JSON.parse(raw);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const conn = await mysql.createConnection(DB_URL);

const [rows] = await conn.execute(`
  SELECT id, sourceImageUrl
  FROM trend_patterns
  WHERE sourceStyleJson IS NOT NULL
    AND JSON_EXTRACT(sourceStyleJson, '$.lineWeight') IS NULL
    AND sourceImageUrl IS NOT NULL
`);

console.log(`Found ${rows.length} legacy rows to backfill.`);
if (rows.length === 0) {
  const [[{ remaining }]] = await conn.execute(`
    SELECT COUNT(*) AS remaining FROM trend_patterns
    WHERE sourceStyleJson IS NOT NULL
      AND JSON_EXTRACT(sourceStyleJson, '$.lineWeight') IS NULL
  `);
  console.log(`Verification: rows still missing lineWeight = ${remaining}`);
  console.log("✅ PASS — nothing to backfill.");
  await conn.end();
  process.exit(0);
}

let updated = 0;
let failed = 0;
for (const row of rows) {
  process.stdout.write(`  [${row.id}] ${row.sourceImageUrl.slice(0, 55)}... `);
  try {
    const style = await extractStyle(row.sourceImageUrl);
    await conn.execute(
      "UPDATE trend_patterns SET sourceStyleJson = ? WHERE id = ?",
      [JSON.stringify(style), row.id]
    );
    console.log(`OK (lineWeight="${style.lineWeight}", technique="${style.technique}")`);
    updated++;
  } catch (e) {
    console.log(`FAIL: ${e.message}`);
    failed++;
  }
}

// Verify
const [[{ remaining }]] = await conn.execute(`
  SELECT COUNT(*) AS remaining FROM trend_patterns
  WHERE sourceStyleJson IS NOT NULL
    AND JSON_EXTRACT(sourceStyleJson, '$.lineWeight') IS NULL
`);

await conn.end();

console.log(`\nBackfill: ${updated} updated, ${failed} failed/skipped.`);
console.log(`Verification: rows still missing lineWeight = ${remaining}`);
if (remaining === 0) {
  console.log("✅ PASS — all rows have 20-field styleJson.");
} else {
  console.log(`❌ FAIL — ${remaining} rows still have legacy schema.`);
  process.exit(1);
}
