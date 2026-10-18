-- Human accounts and workspaces. Every user who already has data (one
-- privacy_settings row per user, seeded on first access) becomes a users row
-- and the owner of their own "Default" workspace, so an upgraded install keeps
-- its owner. Boot does the same for USER_ID on a fresh install.
--
-- The backfill avoids temporary tables (not portable to remote libsql): each
-- membership row is created first with a fresh random workspace id, and the
-- workspaces are then derived from those rows, which are the only ones in the
-- just-created memberships table.
CREATE TABLE `access_codes` (
	`user_id` text PRIMARY KEY NOT NULL,
	`code_hash` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `access_codes_code_hash_idx` ON `access_codes` (`code_hash`);--> statement-breakpoint
CREATE TABLE `invites` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`role` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`used_at` text,
	`used_by` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invites_token_hash_idx` ON `invites` (`token_hash`);--> statement-breakpoint
CREATE INDEX `invites_workspace_idx` ON `invites` (`workspace_id`);--> statement-breakpoint
CREATE TABLE `memberships` (
	`workspace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`workspace_id`, `user_id`)
);
--> statement-breakpoint
CREATE INDEX `memberships_user_idx` ON `memberships` (`user_id`);--> statement-breakpoint
CREATE TABLE `passkeys` (
	`credential_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`public_key` text NOT NULL,
	`counter` integer NOT NULL,
	`transports` text NOT NULL,
	`name` text NOT NULL,
	`created_at` text NOT NULL,
	`last_used_at` text
);
--> statement-breakpoint
CREATE INDEX `passkeys_user_idx` ON `passkeys` (`user_id`);--> statement-breakpoint
CREATE TABLE `recovery_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`lookup_id` text NOT NULL,
	`secret_hash` text NOT NULL,
	`used_at` text
);
--> statement-breakpoint
CREATE INDEX `recovery_codes_lookup_idx` ON `recovery_codes` (`lookup_id`);--> statement-breakpoint
CREATE INDEX `recovery_codes_user_idx` ON `recovery_codes` (`user_id`);--> statement-breakpoint
CREATE TABLE `server_secrets` (
	`name` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id_hash` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`reauth_at` text NOT NULL,
	`user_agent` text
);
--> statement-breakpoint
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `sessions_expires_idx` ON `sessions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `used_nonces` (
	`nonce` text PRIMARY KEY NOT NULL,
	`expires_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `used_nonces_expires_idx` ON `used_nonces` (`expires_at`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`webauthn_handle` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_webauthn_handle_idx` ON `users` (`webauthn_handle`);--> statement-breakpoint
CREATE TABLE `workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `users`("id", "display_name", "webauthn_handle", "created_at") SELECT "user_id", "user_id", lower(hex(randomblob(32))), strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM (SELECT DISTINCT "user_id" FROM `privacy_settings`) WHERE true ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO `memberships`("workspace_id", "user_id", "role", "created_at") SELECT lower(hex(randomblob(16))), "id", 'owner', "created_at" FROM `users`;--> statement-breakpoint
INSERT INTO `workspaces`("id", "name", "created_at") SELECT "workspace_id", 'Default', "created_at" FROM `memberships`;
