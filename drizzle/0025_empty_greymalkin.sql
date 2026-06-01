ALTER TABLE `trend_patterns` ADD `sourceCategory` varchar(100);--> statement-breakpoint
ALTER TABLE `trend_patterns` ADD `transferValid` boolean DEFAULT true;--> statement-breakpoint
ALTER TABLE `trend_patterns` ADD `transferReasoning` text;