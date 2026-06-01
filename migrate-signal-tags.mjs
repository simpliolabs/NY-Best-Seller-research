/**
 * One-time migration: add signalTags JSON column to design_concepts
 * Run: node migrate-signal-tags.mjs
 */
import mysql from "mysql2/promise";
import { config } from "dotenv";
config();

const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL not set"); process.exit(1); }

const conn = await mysql.createConnection(url);
try {
  // Check if column already exists
  const [rows] = await conn.execute(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS 
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'design_concepts' AND COLUMN_NAME = 'signalTags'`
  );
  if (rows.length > 0) {
    console.log("✅ signalTags column already exists — skipping migration");
  } else {
    await conn.execute("ALTER TABLE `design_concepts` ADD `signalTags` json");
    console.log("✅ signalTags column added to design_concepts");
  }
} finally {
  await conn.end();
}
