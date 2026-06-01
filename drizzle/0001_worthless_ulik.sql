CREATE TABLE `books` (
	`id` int AUTO_INCREMENT NOT NULL,
	`runId` int NOT NULL,
	`title` varchar(512) NOT NULL,
	`author` varchar(512) NOT NULL,
	`isbn` varchar(20),
	`coverUrl` text,
	`synopsis` text,
	`rank` int,
	`weeksOnList` int,
	`dominantColors` json,
	`mood` varchar(255),
	`setting` varchar(255),
	`subgenre` varchar(255),
	`visualMotifs` json,
	`typographyStyle` varchar(255),
	`trendScoreTotal` int,
	`socialMomentum` int,
	`socialRationale` text,
	`designNovelty` int,
	`designRationale` text,
	`audienceSize` int,
	`audienceRationale` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `books_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `bot_runs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`status` enum('running','completed','failed') NOT NULL DEFAULT 'running',
	`currentStage` int NOT NULL DEFAULT 0,
	`stageLabel` varchar(255) NOT NULL DEFAULT 'Initializing...',
	`booksProcessed` int NOT NULL DEFAULT 0,
	`topPickTitle` varchar(512),
	`topPickIsbn` varchar(20),
	`errorLog` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`completedAt` timestamp,
	CONSTRAINT `bot_runs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `design_concepts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`bookId` int NOT NULL,
	`runId` int NOT NULL,
	`conceptName` varchar(255) NOT NULL,
	`format` varchar(100) NOT NULL,
	`style` varchar(100) NOT NULL,
	`headline` varchar(512),
	`subtext` varchar(512),
	`colorPalette` json,
	`layoutDescription` text,
	`fontSuggestion` varchar(255),
	`copyrightSafe` boolean NOT NULL DEFAULT true,
	`isFavorite` boolean NOT NULL DEFAULT false,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `design_concepts_id` PRIMARY KEY(`id`)
);
