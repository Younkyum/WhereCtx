CREATE TABLE `location_history` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`lat` real NOT NULL,
	`lon` real NOT NULL,
	`accuracy_m` real,
	`source` text,
	`recorded_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `location_history_recorded_at_idx` ON `location_history` (`recorded_at`);--> statement-breakpoint
CREATE TABLE `places` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`label` text,
	`lat` real NOT NULL,
	`lon` real NOT NULL,
	`radius_m` real NOT NULL,
	`type` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `places_user_name_idx` ON `places` (`user_id`,`name`);--> statement-breakpoint
CREATE TABLE `presence` (
	`user_id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`label` text,
	`precise_lat` real,
	`precise_lon` real,
	`accuracy_m` real,
	`altitude_m` real,
	`speed_mps` real,
	`heading_deg` real,
	`geohash` text,
	`city` text,
	`area` text,
	`coarse_place_type` text,
	`motion` text,
	`battery_level` real,
	`battery_charging` integer,
	`source` text NOT NULL,
	`privacy_mode` text NOT NULL,
	`allow_precise_to_agents` integer DEFAULT false NOT NULL,
	`current_place_name` text,
	`stale_event_fired` integer DEFAULT false NOT NULL,
	`updated_at` text NOT NULL,
	`received_at` text NOT NULL,
	`stale_after_sec` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `presence_events` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`place_name` text,
	`status` text,
	`source` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `presence_events_created_at_idx` ON `presence_events` (`created_at`);--> statement-breakpoint
CREATE TABLE `privacy_settings` (
	`user_id` text PRIMARY KEY NOT NULL,
	`default_agent_access` text NOT NULL,
	`allow_precise_location` integer DEFAULT false NOT NULL,
	`precise_requires_reason` integer DEFAULT true NOT NULL,
	`precise_requires_approval` integer DEFAULT false NOT NULL,
	`hide_home_exact_coordinates` integer DEFAULT true NOT NULL,
	`retention_hours` integer DEFAULT 24 NOT NULL,
	`store_raw_history` integer DEFAULT false NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `reminders` (
	`id` text PRIMARY KEY NOT NULL,
	`place_name` text NOT NULL,
	`message` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	`triggered_at` text
);
--> statement-breakpoint
CREATE INDEX `reminders_active_idx` ON `reminders` (`active`);--> statement-breakpoint
CREATE TABLE `tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`role` text NOT NULL,
	`scopes` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_at` text NOT NULL,
	`last_used_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tokens_token_hash_idx` ON `tokens` (`token_hash`);--> statement-breakpoint
CREATE TABLE `webhooks` (
	`id` text PRIMARY KEY NOT NULL,
	`url` text NOT NULL,
	`events` text NOT NULL,
	`secret` text,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL
);
