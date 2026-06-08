ALTER TABLE `niche_scan_runs` ADD `conceptMode` enum('auto','curated') DEFAULT 'auto' NOT NULL;--> statement-breakpoint
ALTER TABLE `trend_patterns` ADD `conceptOptions` json;--> statement-breakpoint
ALTER TABLE `trend_patterns` ADD `chosenConcept` text;