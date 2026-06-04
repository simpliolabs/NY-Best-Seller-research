/**
 * Re-run the 3 failed rows (opaque productionDesignUrl) through the validated pipeline.
 *
 * Rows:
 *   qGANi1bv_VcP9sdKdK2G0 — I Fix Shit
 *   5VQvCWKAh9NJEUzZPgqAe — Salty Girl
 *   9FsNIfbqauJXrT3cI_MAf — Retro Landscape (Dinosaur)
 *
 * The pipeline now includes assertTransparentPng before storagePut.
 * Each row will either:
 *   PASS: transparent PNG written to productionDesignUrl
 *   FAIL LOUD: error logged, no opaque PNG stored, productionDesignUrl unchanged
 *
 * Run: node scripts/rerun_failed_rows.mjs
 */
import { createConnection } from "mysql2/promise";
import { register } from "tsx/esm/api";
register();

const { processPatternProduction } = await import("../server/patternProductionProcessor.ts");

const FAILED_ROWS = [
  {
    id: "qGANi1bv_VcP9sdKdK2G0",
    name: "I Fix Shit",
    workspaceId: "pXpoItQDHSNGjGro2UMbh",
  },
  {
    id: "5VQvCWKAh9NJEUzZPgqAe",
    name: "Salty Girl",
    workspaceId: "pXpoItQDHSNGjGro2UMbh",
  },
  {
    id: "9FsNIfbqauJXrT3cI_MAf",
    name: "Retro Landscape (Dinosaur)",
    workspaceId: "pXpoItQDHSNGjGro2UMbh",
  },
];

const conn = await createConnection(process.env.DATABASE_URL);

for (const row of FAILED_ROWS) {
  console.log(`\n=== Processing: ${row.name} (${row.id}) ===`);

  // Fetch current sourceImageUrl and adaptedConcept from DB
  const [rows] = await conn.execute(
    "SELECT sourceImageUrl, adaptedConcept FROM trend_patterns WHERE id = ?",
    [row.id]
  );
  const record = rows[0];
  if (!record) {
    console.error(`  ERROR: Row ${row.id} not found in DB`);
    continue;
  }
  if (!record.sourceImageUrl) {
    console.error(`  ERROR: Row ${row.id} has no sourceImageUrl`);
    continue;
  }
  if (!record.adaptedConcept) {
    console.error(`  ERROR: Row ${row.id} has no adaptedConcept`);
    continue;
  }

  console.log(`  sourceImageUrl: ${record.sourceImageUrl.substring(0, 80)}`);
  console.log(`  adaptedConcept: ${record.adaptedConcept.substring(0, 80)}`);

  try {
    const result = await processPatternProduction(
      row.id,
      row.workspaceId,
      record.sourceImageUrl,
      record.adaptedConcept
    );
    console.log(`  ✓ PASS: productionDesignUrl = ${result.productionDesignUrl.substring(0, 80)}`);
    console.log(`  ✓ PASS: previewImageUrl = ${result.previewImageUrl.substring(0, 80)}`);
  } catch (err) {
    console.error(`  ✗ FAIL LOUD: ${err.message}`);
    console.error(`  → productionDesignUrl NOT updated (old opaque URL preserved)`);
  }
}

await conn.end();
console.log("\n=== Re-run complete ===");
