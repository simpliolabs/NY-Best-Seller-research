ALTER TABLE `books` ADD `trendDirection` enum('up','down','stable','new') DEFAULT 'new';--> statement-breakpoint
ALTER TABLE `books` ADD `previousTrendScore` int;--> statement-breakpoint
ALTER TABLE `books` ADD `scoreDelta` int;--> statement-breakpoint
ALTER TABLE `books` ADD `previousRank` int;--> statement-breakpoint
ALTER TABLE `books` ADD `streakCount` int DEFAULT 1;