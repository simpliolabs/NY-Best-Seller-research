CREATE TABLE `niche_scan_runs` (
	`id` varchar(36) NOT NULL,
	`workspaceId` varchar(36) NOT NULL,
	`status` enum('running','completed','failed') NOT NULL DEFAULT 'running',
	`progress` int NOT NULL DEFAULT 0,
	`patternsFound` int NOT NULL DEFAULT 0,
	`errorLog` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`completedAt` timestamp,
	CONSTRAINT `niche_scan_runs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `trend_patterns` (
	`id` varchar(36) NOT NULL,
	`workspaceId` varchar(36) NOT NULL,
	`scanId` varchar(36),
	`sourcePlatform` varchar(20),
	`sourceTitle` varchar(255),
	`sourceImageUrl` text,
	`sourceSales` int,
	`patternName` varchar(200) NOT NULL,
	`composition` varchar(100),
	`colorStrategy` varchar(100),
	`emotionalHook` text,
	`transferablePattern` text,
	`whyItWorks` text,
	`adaptedConcept` text,
	`status` enum('discovered','approved','dismissed') NOT NULL DEFAULT 'discovered',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `trend_patterns_id` PRIMARY KEY(`id`)
);
