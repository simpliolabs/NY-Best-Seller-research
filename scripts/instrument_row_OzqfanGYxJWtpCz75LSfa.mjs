/**
 * Instrument script: reconstruct the exact prompt sent to Forge for row OzqfanGYxJWtpCz75LSfa.
 * Pulls sourceStyleJson from DB, maps all 20 fields against what buildGenerationPayload uses.
 *
 * Run: node scripts/instrument_row_OzqfanGYxJWtpCz75LSfa.mjs
 */
import dotenv from "dotenv";
dotenv.config({ path: "/home/ubuntu/nyt-design-bot/.env" });
import mysql from "mysql2/promise";

const conn = await mysql.createConnection(process.env.DATABASE_URL);

const [rows] = await conn.execute(
  `SELECT id, sourceImageUrl, sourceStyleJson, adaptedConcept, adaptationMode,
          composition, colorStrategy, emotionalHook, transferablePattern, whyItWorks,
          patternName, transferValid, transferReasoning
   FROM trend_patterns WHERE id = ?`,
  ["OzqfanGYxJWtpCz75LSfa"]
);
const row = rows[0];
await conn.end();

if (!row) { console.error("Row not found"); process.exit(1); }

// ─── 1. Full sourceStyleJson — all fields verbatim ────────────────────────────

const stored = typeof row.sourceStyleJson === "string"
  ? JSON.parse(row.sourceStyleJson)
  : row.sourceStyleJson;

// The 20 fields defined in styleExtractor.ts schema
const SCHEMA_FIELDS_20 = [
  "inkColors", "inkColorNames", "shirtColorRole", "technique", "lineWeight",
  "shadingMethod", "textureDetail", "subject", "subjectCrop", "composition",
  "framingDevice", "scaleCoverage", "textPresence", "textStyle", "mood",
  "humorMechanism", "printMethod", "garmentStyle", "designEra", "backgroundTreatment",
];

console.log("\n" + "=".repeat(60));
console.log("FULL sourceStyleJson — all 20 schema fields");
console.log("=".repeat(60));
for (const field of SCHEMA_FIELDS_20) {
  const val = stored?.[field];
  const status = val !== undefined ? "PRESENT" : "MISSING";
  const display = val !== undefined
    ? (Array.isArray(val) ? JSON.stringify(val) : String(val))
    : "(not in DB)";
  console.log(`  [${status}] ${field}: ${display}`);
}

// ─── 2. Fields actually used in buildGenerationPayload's styleDesc ────────────

// From nicheHunter.ts lines 561-571:
// const styleDesc = [
//   `Technique: ${sourceStyle.technique}`,
//   `Line weight: ${sourceStyle.lineWeight}`,
//   `Shading: ${sourceStyle.shadingMethod}`,
//   `Texture: ${sourceStyle.textureDetail}`,
//   `Colors: ${sourceStyle.inkColors.join(", ")}`,
//   `Composition: ${sourceStyle.composition}`,
//   `Framing: ${sourceStyle.framingDevice !== "NONE" ? sourceStyle.framingDevice : "none"}`,
//   `Text style: ${sourceStyle.textStyle !== "NONE" ? sourceStyle.textStyle : "none"}`,
//   `Design era: ${sourceStyle.designEra}`,
// ].join(". ");

const USED_IN_PROMPT = new Set([
  "technique", "lineWeight", "shadingMethod", "textureDetail",
  "inkColors", "composition", "framingDevice", "textStyle", "designEra",
]);

const UNUSED_IN_PROMPT = SCHEMA_FIELDS_20.filter(f => !USED_IN_PROMPT.has(f));

console.log("\n" + "=".repeat(60));
console.log("FIELD COVERAGE: used in styleDesc vs unused");
console.log("=".repeat(60));
console.log("\n  USED in prompt (9 fields):");
for (const f of USED_IN_PROMPT) {
  const val = stored?.[f];
  const display = val !== undefined
    ? (Array.isArray(val) ? JSON.stringify(val) : String(val))
    : "(MISSING FROM DB — will be undefined in prompt)";
  console.log(`    ✅ ${f}: ${display}`);
}
console.log("\n  UNUSED in prompt (11 fields — sit in DB, never interpolated):");
for (const f of UNUSED_IN_PROMPT) {
  const val = stored?.[f];
  const display = val !== undefined
    ? (Array.isArray(val) ? JSON.stringify(val) : String(val))
    : "(also missing from DB)";
  console.log(`    ❌ ${f}: ${display}`);
}

// ─── 3. Reconstruct the exact prompt ─────────────────────────────────────────

// Pull pickleball workspace TVCs
const conn2 = await mysql.createConnection(process.env.DATABASE_URL);
const [wsRows] = await conn2.execute(
  "SELECT nicheProfile FROM workspaces WHERE slug = ?",
  ["pickleball"]
);
const nicheProfile = typeof wsRows[0]?.nicheProfile === "string"
  ? JSON.parse(wsRows[0].nicheProfile)
  : wsRows[0]?.nicheProfile;
await conn2.end();

const tvc = nicheProfile?.culturalMap?.transferableVisualConcepts ?? [];

// Reconstruct styleDesc (using stored values — note: stored only has 7 fields, not 20)
const s = stored ?? {};
const styleDesc = [
  `Technique: ${s.technique ?? "undefined"}`,
  `Line weight: ${s.lineWeight ?? "undefined"}`,
  `Shading: ${s.shadingMethod ?? "undefined"}`,
  `Texture: ${s.textureDetail ?? "undefined"}`,
  `Colors: ${Array.isArray(s.inkColors) ? s.inkColors.join(", ") : (s.primaryColors ?? []).join(", ")}`,
  `Composition: ${s.composition ?? "undefined"}`,
  `Framing: ${s.framingDevice && s.framingDevice !== "NONE" ? s.framingDevice : "none"}`,
  `Text style: ${s.textStyle && s.textStyle !== "NONE" ? s.textStyle : "none"}`,
  `Design era: ${s.designEra ?? "undefined"}`,
].join(". ");

// Reconstruct character swap
const STOPWORDS = new Set([
  "a","an","the","and","or","of","in","on","at","to","for",
  "with","by","from","is","it","its","as","are","was","be",
  "this","that","have","has","had","do","does","did","not",
]);
const tokenize = (text) => new Set(
  text.toLowerCase().split(/[\s/,\-–—.!?()]+/).filter(w => w.length > 2 && !STOPWORDS.has(w))
);

const sourceSubject = s.subject ?? "";
const sourceTokens = tokenize(sourceSubject);
let bestMatch = null;
let bestOverlap = 0;
for (const m of tvc) {
  const patternTokens = tokenize(m.sourcePattern ?? "");
  let overlap = 0;
  Array.from(patternTokens).forEach(t => { if (sourceTokens.has(t)) overlap++; });
  if (overlap >= 2 && overlap > bestOverlap) { bestOverlap = overlap; bestMatch = m; }
}

const swapInstruction = bestMatch
  ? `SWAP the character: replace "${sourceSubject}" with "${bestMatch.targetAdaptation}". Reason: ${bestMatch.whyItTransfers}`
  : `Replace the depicted character/subject with: ${row.adaptedConcept}`;

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
].join("\n");

console.log("\n" + "=".repeat(60));
console.log("EXACT PROMPT SENT TO FORGE (verbatim)");
console.log("=".repeat(60));
console.log(prompt);

// ─── 4. Key diagnosis ─────────────────────────────────────────────────────────

console.log("\n" + "=".repeat(60));
console.log("DIAGNOSIS SUMMARY");
console.log("=".repeat(60));
console.log(`\nstyleDesc line 4 (art style): "${styleDesc}"`);
console.log(`\nFields stored in DB for this row: ${Object.keys(stored ?? {}).join(", ")}`);
console.log(`\nFields MISSING from DB (style extractor used a 7-field schema, not the 20-field schema):`);
const storedKeys = new Set(Object.keys(stored ?? {}));
for (const f of SCHEMA_FIELDS_20) {
  if (!storedKeys.has(f)) console.log(`  MISSING: ${f}`);
}
console.log(`\nResult: styleDesc line 4 interpolates "undefined" for technique, lineWeight,`);
console.log(`shadingMethod, textureDetail, framingDevice, textStyle, designEra.`);
console.log(`The model received no concrete style descriptors — it defaulted to flat illustration.`);
