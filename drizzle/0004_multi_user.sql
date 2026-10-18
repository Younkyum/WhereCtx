-- Rebuild the four tables that predate per-user scoping so user_id is NOT NULL
-- with no default (SQLite cannot add such a column, or drop a default, in place).
-- Existing rows belong to the single v0.1 user, whose id is the one row in
-- privacy_settings (seeded from USER_ID on first boot); 'default' covers an
-- install that never wrote that row.
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`role` text NOT NULL,
	`scopes` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_at` text NOT NULL,
	`last_used_at` text
);
--> statement-breakpoint
INSERT INTO `__new_tokens`("id", "user_id", "name", "role", "scopes", "token_hash", "created_at", "last_used_at") SELECT "id", COALESCE((SELECT "user_id" FROM `privacy_settings` ORDER BY "updated_at" DESC LIMIT 1), 'default'), "name", "role", "scopes", "token_hash", "created_at", "last_used_at" FROM `tokens`;--> statement-breakpoint
DROP TABLE `tokens`;--> statement-breakpoint
ALTER TABLE `__new_tokens` RENAME TO `tokens`;--> statement-breakpoint
CREATE UNIQUE INDEX `tokens_token_hash_idx` ON `tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `tokens_user_idx` ON `tokens` (`user_id`);--> statement-breakpoint
CREATE TABLE `__new_presence_events` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`type` text NOT NULL,
	`place_name` text,
	`status` text,
	`source` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_presence_events`("id", "user_id", "type", "place_name", "status", "source", "created_at") SELECT "id", COALESCE((SELECT "user_id" FROM `privacy_settings` ORDER BY "updated_at" DESC LIMIT 1), 'default'), "type", "place_name", "status", "source", "created_at" FROM `presence_events`;--> statement-breakpoint
DROP TABLE `presence_events`;--> statement-breakpoint
ALTER TABLE `__new_presence_events` RENAME TO `presence_events`;--> statement-breakpoint
CREATE INDEX `presence_events_created_at_idx` ON `presence_events` (`created_at`);--> statement-breakpoint
CREATE INDEX `presence_events_user_created_idx` ON `presence_events` (`user_id`,`created_at`,`id`);--> statement-breakpoint
CREATE TABLE `__new_webhooks` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`url` text NOT NULL,
	`events` text NOT NULL,
	`secret` text,
	`active` integer DEFAULT true NOT NULL,
	`cursor` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_webhooks`("id", "user_id", "url", "events", "secret", "active", "cursor", "created_at") SELECT "id", COALESCE((SELECT "user_id" FROM `privacy_settings` ORDER BY "updated_at" DESC LIMIT 1), 'default'), "url", "events", "secret", "active", "cursor", "created_at" FROM `webhooks`;--> statement-breakpoint
DROP TABLE `webhooks`;--> statement-breakpoint
ALTER TABLE `__new_webhooks` RENAME TO `webhooks`;--> statement-breakpoint
CREATE INDEX `webhooks_user_idx` ON `webhooks` (`user_id`);--> statement-breakpoint
CREATE TABLE `__new_reminders` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`place_name` text NOT NULL,
	`message` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	`triggered_at` text
);
--> statement-breakpoint
INSERT INTO `__new_reminders`("id", "user_id", "place_name", "message", "active", "created_at", "triggered_at") SELECT "id", COALESCE((SELECT "user_id" FROM `privacy_settings` ORDER BY "updated_at" DESC LIMIT 1), 'default'), "place_name", "message", "active", "created_at", "triggered_at" FROM `reminders`;--> statement-breakpoint
DROP TABLE `reminders`;--> statement-breakpoint
ALTER TABLE `__new_reminders` RENAME TO `reminders`;--> statement-breakpoint
CREATE INDEX `reminders_user_active_idx` ON `reminders` (`user_id`,`active`);--> statement-breakpoint
PRAGMA foreign_keys=ON;
