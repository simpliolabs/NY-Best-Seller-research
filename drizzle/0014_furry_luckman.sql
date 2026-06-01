CREATE TABLE `mockup_templates` (
	`id` varchar(36) NOT NULL,
	`groupId` varchar(36) NOT NULL,
	`colorName` varchar(100) NOT NULL,
	`colorHex` varchar(7) NOT NULL DEFAULT '#000000',
	`imageUrl` text NOT NULL,
	`imageKey` varchar(500) NOT NULL,
	`availableSizes` json NOT NULL,
	`sortOrder` int NOT NULL DEFAULT 0,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `mockup_templates_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `product_groups` (
	`id` varchar(36) NOT NULL,
	`workspaceId` varchar(36) NOT NULL,
	`name` varchar(255) NOT NULL,
	`slug` varchar(100) NOT NULL,
	`description` text,
	`compareAtPrice` decimal(10,2),
	`pricingTiers` json,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `product_groups_id` PRIMARY KEY(`id`)
);
