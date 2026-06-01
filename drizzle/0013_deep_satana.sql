CREATE TABLE `workspace_credentials` (
	`id` varchar(36) NOT NULL,
	`workspaceId` varchar(36) NOT NULL,
	`provider` varchar(50) NOT NULL,
	`credKey` varchar(100) NOT NULL,
	`credValue` text NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `workspace_credentials_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `workspaces` (
	`id` varchar(36) NOT NULL,
	`name` varchar(100) NOT NULL,
	`slug` varchar(50) NOT NULL,
	`icon` varchar(10) NOT NULL DEFAULT '🎯',
	`workspaceType` enum('nyt','niche_hunter') NOT NULL,
	`ownerId` varchar(64) NOT NULL,
	`nicheProfile` json,
	`pipelineConfig` json,
	`descriptionTemplate` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `workspaces_id` PRIMARY KEY(`id`),
	CONSTRAINT `workspaces_slug_unique` UNIQUE(`slug`)
);
