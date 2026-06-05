ALTER TABLE `trend_patterns` MODIFY COLUMN `adaptationMode` varchar(40);--> statement-breakpoint
ALTER TABLE `niche_scan_runs` ADD `searchLog` json;