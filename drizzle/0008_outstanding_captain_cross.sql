CREATE TABLE `healing_log` (
	`id` int AUTO_INCREMENT NOT NULL,
	`subsystem` varchar(50) NOT NULL,
	`issue` text NOT NULL,
	`classification` varchar(50),
	`diagnosis` text,
	`actionTaken` text,
	`result` enum('success','fallback','escalated') NOT NULL,
	`mttrSeconds` int,
	`runId` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `healing_log_id` PRIMARY KEY(`id`)
);
