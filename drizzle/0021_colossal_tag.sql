CREATE TABLE `design_revisions` (
	`id` varchar(36) NOT NULL,
	`conceptId` int NOT NULL,
	`variationKey` varchar(1) NOT NULL,
	`iterationNumber` int NOT NULL DEFAULT 1,
	`instruction` text,
	`referenceImageUrl` text,
	`resultImageUrl` text NOT NULL,
	`accepted` boolean NOT NULL DEFAULT false,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `design_revisions_id` PRIMARY KEY(`id`)
);
