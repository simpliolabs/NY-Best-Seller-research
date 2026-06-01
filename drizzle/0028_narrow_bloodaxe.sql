CREATE TABLE `shopify_listings` (
	`id` varchar(36) NOT NULL,
	`workspaceId` varchar(36) NOT NULL,
	`conceptId` int NOT NULL,
	`productGroupId` varchar(36) NOT NULL,
	`title` varchar(255) NOT NULL,
	`description` text,
	`tags` json,
	`price` decimal(10,2) NOT NULL,
	`compareAtPrice` decimal(10,2),
	`mockupRenderIds` json NOT NULL,
	`listingStatus` enum('draft','ready','exported') NOT NULL DEFAULT 'draft',
	`shopifyProductId` varchar(64),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `shopify_listings_id` PRIMARY KEY(`id`)
);
