CREATE TABLE `market_validation` (
	`id` int AUTO_INCREMENT NOT NULL,
	`conceptId` int NOT NULL,
	`etsyListingCount` int,
	`avgPrice` decimal(10,2),
	`minPrice` decimal(10,2),
	`maxPrice` decimal(10,2),
	`topFavorites` int,
	`saturationLevel` enum('low','medium','high','unavailable') NOT NULL DEFAULT 'unavailable',
	`searchKeywords` varchar(512),
	`validatedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `market_validation_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `niche_research` (
	`id` int AUTO_INCREMENT NOT NULL,
	`runId` int NOT NULL,
	`bookId` int NOT NULL,
	`fanConversations` json,
	`designStyles` json,
	`whiteSpace` json,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `niche_research_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `books` ADD `fanCulture` text;--> statement-breakpoint
ALTER TABLE `bot_runs` ADD `totalStages` int DEFAULT 7 NOT NULL;--> statement-breakpoint
ALTER TABLE `bot_runs` ADD `imagesGenerated` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `design_concepts` ADD `humorFramework` varchar(100);--> statement-breakpoint
ALTER TABLE `design_concepts` ADD `imageUrlA` text;--> statement-breakpoint
ALTER TABLE `design_concepts` ADD `imageUrlB` text;--> statement-breakpoint
ALTER TABLE `design_concepts` ADD `imagePromptA` text;--> statement-breakpoint
ALTER TABLE `design_concepts` ADD `imagePromptB` text;--> statement-breakpoint
ALTER TABLE `design_concepts` ADD `trendScore` int;--> statement-breakpoint
ALTER TABLE `design_concepts` ADD `nicheResearchId` int;