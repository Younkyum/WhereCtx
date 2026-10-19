CREATE TABLE `ingest_log` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token_id` text,
	`token_name` text,
	`source` text NOT NULL,
	`outcome` text NOT NULL,
	`reason` text,
	`received_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ingest_log_user_received_idx` ON `ingest_log` (`user_id`,`received_at`,`id`);--> statement-breakpoint
CREATE INDEX `ingest_log_token_received_idx` ON `ingest_log` (`token_id`,`received_at`);--> statement-breakpoint
CREATE INDEX `ingest_log_received_at_idx` ON `ingest_log` (`received_at`);