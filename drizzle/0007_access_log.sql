CREATE TABLE `access_log` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`credential_kind` text NOT NULL,
	`credential_id` text NOT NULL,
	`credential_name` text NOT NULL,
	`surface` text NOT NULL,
	`action` text NOT NULL,
	`precise` integer NOT NULL,
	`reason` text,
	`outcome` text NOT NULL,
	`denial` text,
	`count` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`last_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `access_log_user_created_idx` ON `access_log` (`user_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `access_log_created_at_idx` ON `access_log` (`created_at`);--> statement-breakpoint
CREATE INDEX `access_log_coalesce_idx` ON `access_log` (`user_id`,`credential_id`,`last_at`);