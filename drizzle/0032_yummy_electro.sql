ALTER TABLE `trend_patterns` ADD `sourceStyleJson` json;--> statement-breakpoint
ALTER TABLE `trend_patterns` ADD `adaptationMode` varchar(20);--> statement-breakpoint
ALTER TABLE `trend_patterns` ADD `approvalReason` text;--> statement-breakpoint
ALTER TABLE `trend_patterns` ADD `rejectionReason` text;--> statement-breakpoint
ALTER TABLE `trend_patterns` ADD `approvalTags` json;--> statement-breakpoint
ALTER TABLE `trend_patterns` ADD `rejectionTags` json;--> statement-breakpoint
ALTER TABLE `trend_patterns` ADD `approvedAt` timestamp;--> statement-breakpoint
ALTER TABLE `trend_patterns` ADD `dismissedAt` timestamp;--> statement-breakpoint
ALTER TABLE `trend_patterns` ADD `dtfImageUrl` text;