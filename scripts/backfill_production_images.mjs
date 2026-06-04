/**
 * Addition D — Backfill all stuck pattern production images.
 *
 * Two passes:
 *
 * Pass 1 — Opaque rows (productionDesignUrl IS NOT NULL but contains an opaque PNG):
 *   The 3 known-bad rows from the pre-rebuild validation run.
 *   We clear productionDesignUrl to NULL first, then they fall into Pass 2.
 *
 * Pass 2 — Stuck rows (sourceImageUrl IS NOT NULL AND productionDesignUrl IS NULL):
 *   All rows that never got a production image, plus the 3 cleared in Pass 1.
 *   Processed one at a time through the new 2-step pipeline.
 *
 * Acceptance: SELECT COUNT(*) FROM trend_patterns
 *   WHERE sourceImageUrl IS NOT NULL AND productionDesignUrl IS NULL
 *   returns 0 after this script completes.
 *
 * Run: node --import tsx/esm scripts/backfill_production_images.mjs
 */
import { createConnection } from "mysql2/promise";
import { register } from "tsx/esm/api";
register();

const { processPatternProduction } = await import("../server/patternProductionProcessor.ts");

// ─── Pass 1: Clear the 3 known-opaque rows ────────────────────────────────────

const OPAQUE_ROW_IDS = [
  "qGANi1bv_VcP9sdKdK2G0", // I Fix Shit
  "5VQvCWKAh9NJEUzZPgqAe", // Salty Girl
  "9FsNIfbqauJXrT3cI_MAf", // Retro Landscape (Dinosaur)
];

const conn = await createConnection(process.env.DATABASE_URL);

console.log("=== Pass 1: Clearing 3 known-opaque productionDesignUrl rows ===");
for (const id of OPAQUE_ROW_IDS) {
  await conn.execute(
    "UPDATE trend_patterns SET productionDesignUrl = NULL WHERE id = ?",
    [id]
  );
  console.log(`  Cleared productionDesignUrl for ${id}`);
}

// ─── Pass 2: Process all stuck rows ───────────────────────────────────────────

console.log("\n=== Pass 2: Processing all stuck rows (sourceImageUrl IS NOT NULL AND productionDesignUrl IS NULL) ===");

const [stuckRows] = await conn.execute(
  `SELECT id, workspaceId, sourceImageUrl, adaptedConcept, characterSwaps, contextSwaps, patternName
   FROM trend_patterns
   WHERE workspaceId = 'pXpoItQDHSNGjGro2UMbh'
     AND sourceImageUrl IS NOT NULL AND productionDesignUrl IS NULL
   ORDER BY createdAt ASC`
);

console.log(`  Found ${stuckRows.length} stuck rows to process`);

let passed = 0;
let failed = 0;
const failures = [];

for (const row of stuckRows) {
  console.log(`\n--- Processing: ${row.patternName?.substring(0, 50)} (${row.id}) ---`);

  // Build editPrompt from characterSwaps/contextSwaps (same logic as nicheHunter.ts lines 1139-1165)
  let editPrompt;
  try {
    const characterSwaps = row.characterSwaps ? JSON.parse(row.characterSwaps) : [];
    const contextSwaps = row.contextSwaps ? JSON.parse(row.contextSwaps) : [];
    const parts = [];
    if (characterSwaps.length > 0) {
      parts.push(...characterSwaps.map(s => `Replace the ${s.from} with a ${s.to}.`));
    }
    if (contextSwaps.length > 0) {
      parts.push(...contextSwaps.map(s => `Replace "${s.from}" with "${s.to}".`));
    }
    editPrompt = parts.length > 0
      ? parts.join(" ")
      : `Replace the main subject with: ${row.adaptedConcept}.`;
  } catch {
    editPrompt = `Replace the main subject with: ${row.adaptedConcept}.`;
  }

  console.log(`  editPrompt: ${editPrompt.substring(0, 100)}`);

  try {
    const result = await processPatternProduction(
      row.id,
      row.workspaceId,
      row.sourceImageUrl,
      editPrompt
    );
    console.log(`  ✓ PASS: productionDesignUrl = ${result.productionDesignUrl.substring(0, 80)}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ FAIL: ${err.message}`);
    failed++;
    failures.push({ id: row.id, name: row.patternName, error: err.message });
  }
}

// ─── Final count check ────────────────────────────────────────────────────────

const [[countRow]] = await conn.execute(
  `SELECT COUNT(*) AS stuck FROM trend_patterns WHERE workspaceId = 'pXpoItQDHSNGjGro2UMbh' AND sourceImageUrl IS NOT NULL AND productionDesignUrl IS NULL`
);

await conn.end();

console.log("\n=== Backfill complete ===");
console.log(`  Passed: ${passed}`);
console.log(`  Failed: ${failed}`);
console.log(`  Remaining stuck (acceptance check): ${countRow.stuck}`);

if (failures.length > 0) {
  console.log("\n  Failed rows:");
  for (const f of failures) {
    console.log(`    ${f.id} — ${f.name?.substring(0, 40)}: ${f.error.substring(0, 100)}`);
  }
}

if (countRow.stuck === 0) {
  console.log("\n  ✓ ACCEPTANCE CRITERION MET: COUNT(*) = 0");
} else {
  console.log(`\n  ✗ ACCEPTANCE CRITERION NOT MET: ${countRow.stuck} rows still stuck`);
}
