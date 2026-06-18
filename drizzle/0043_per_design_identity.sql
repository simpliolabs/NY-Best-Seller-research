-- Per-design identity (PO 2026-06-17): each design version gets its own name + mockups tie to it.
-- Both columns are NULLABLE — legacy rows pre-migration are unaffected. NULL sourceRevisionId means
-- the mockup belongs to whatever is live in slot A (current behavior, no-op for existing renders).

ALTER TABLE `mockup_renders`
  ADD COLUMN `sourceRevisionId` varchar(36);

ALTER TABLE `design_revisions`
  ADD COLUMN `name` varchar(120);

CREATE INDEX `idx_mockup_renders_source_revision` ON `mockup_renders` (`sourceRevisionId`);
