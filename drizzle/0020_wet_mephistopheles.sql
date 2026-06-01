CREATE TABLE `mockup_renders` (
	`id` varchar(36) NOT NULL,
	`conceptId` int NOT NULL,
	`variationKey` varchar(1) NOT NULL,
	`templateId` varchar(36) NOT NULL,
	`compositeUrl` text NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `mockup_renders_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `product_groups` ADD `printZone` json;