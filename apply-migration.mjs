import mysql from 'mysql2/promise';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL not set'); process.exit(1); }

const conn = await mysql.createConnection(url);

const statements = [
  "ALTER TABLE `books` ADD `refreshedAt` timestamp",
  "ALTER TABLE `design_concepts` ADD `refreshSource` enum('full_run','book_refresh') DEFAULT 'full_run'",
  "ALTER TABLE `design_concepts` ADD `productionUrlA` text",
  "ALTER TABLE `design_concepts` ADD `productionUrlB` text",
  "ALTER TABLE `design_concepts` ADD `productionUrlC` text",
  "ALTER TABLE `bot_runs` ADD `lastHeartbeat` timestamp",
  `CREATE TABLE IF NOT EXISTS healing_log (
    id int AUTO_INCREMENT NOT NULL,
    subsystem varchar(50) NOT NULL,
    issue text NOT NULL,
    classification varchar(50),
    diagnosis text,
    actionTaken text,
    result enum('success','fallback','escalated') NOT NULL,
    mttrSeconds int,
    runId int,
    createdAt timestamp NOT NULL DEFAULT (now()),
    CONSTRAINT healing_log_id PRIMARY KEY(id)
  )`,
];

for (const stmt of statements) {
  try {
    await conn.execute(stmt);
    console.log('OK:', stmt.slice(0, 60));
  } catch (e) {
    if (e.code === 'ER_DUP_FIELDNAME' || e.code === 'ER_TABLE_EXISTS_ERROR') {
      console.log('SKIP (already exists):', stmt.slice(0, 60));
    } else {
      console.error('FAIL:', e.message);
    }
  }
}

await conn.end();
console.log('Migration complete');
