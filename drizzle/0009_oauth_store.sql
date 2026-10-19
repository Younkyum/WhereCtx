CREATE TABLE `oauth_store` (
	`model` text NOT NULL,
	`id` text NOT NULL,
	`payload` text NOT NULL,
	`grant_id` text,
	`uid` text,
	`user_code` text,
	`account_id` text,
	`client_name` text,
	`expires_at` integer,
	`consumed_at` integer,
	PRIMARY KEY(`model`, `id`)
);
--> statement-breakpoint
CREATE INDEX `oauth_store_grant_idx` ON `oauth_store` (`grant_id`);--> statement-breakpoint
CREATE INDEX `oauth_store_uid_idx` ON `oauth_store` (`model`,`uid`);--> statement-breakpoint
CREATE INDEX `oauth_store_user_code_idx` ON `oauth_store` (`model`,`user_code`);--> statement-breakpoint
CREATE INDEX `oauth_store_account_idx` ON `oauth_store` (`model`,`account_id`);--> statement-breakpoint
CREATE INDEX `oauth_store_expires_idx` ON `oauth_store` (`expires_at`);