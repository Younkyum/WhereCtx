CREATE TABLE `location_shares` (
	`owner_user_id` text NOT NULL,
	`viewer_user_id` text NOT NULL,
	`level` text NOT NULL,
	`hide_home_exact` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`owner_user_id`, `viewer_user_id`)
);
--> statement-breakpoint
CREATE INDEX `location_shares_viewer_idx` ON `location_shares` (`viewer_user_id`);--> statement-breakpoint
ALTER TABLE `presence_events` ADD `viewer_user_id` text;--> statement-breakpoint
ALTER TABLE `presence_events` ADD `share_level` text;