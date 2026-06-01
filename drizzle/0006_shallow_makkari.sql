ALTER TABLE `books` ADD `refreshedAt` timestamp;--> statement-breakpoint
ALTER TABLE `design_concepts` ADD `refreshSource` enum('full_run','book_refresh') DEFAULT 'full_run';