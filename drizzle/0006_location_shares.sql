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
CREATE TABLE `share_audit` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`viewer_user_id` text NOT NULL,
	`action` text NOT NULL,
	`reason` text,
	`before_level` text,
	`after_level` text,
	`before_hide_home` integer,
	`after_hide_home` integer,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `share_audit_owner_created_idx` ON `share_audit` (`owner_user_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `privacy_settings` ADD `sharing_paused` integer DEFAULT false NOT NULL;--> statement-breakpoint
-- Hand-written (drizzle-kit does not model triggers): when a membership goes,
-- every share between that person and someone they no longer have a workspace
-- in common with is audited as ended and deleted, whatever code path removed
-- the membership. Timestamps come from SQLite's clock in the app's ISO format.
CREATE TRIGGER `memberships_end_orphaned_shares` AFTER DELETE ON `memberships`
BEGIN
	INSERT INTO `share_audit` (`id`, `owner_user_id`, `viewer_user_id`, `action`, `reason`, `before_level`, `after_level`, `before_hide_home`, `after_hide_home`, `created_at`)
	SELECT lower(hex(randomblob(16))), s.`owner_user_id`, s.`viewer_user_id`, 'revoked', 'membership_ended', s.`level`, NULL, s.`hide_home_exact`, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
	FROM `location_shares` AS s
	WHERE (s.`owner_user_id` = OLD.`user_id` OR s.`viewer_user_id` = OLD.`user_id`)
		AND NOT EXISTS (
			SELECT 1 FROM `memberships` AS a
			INNER JOIN `memberships` AS b ON b.`workspace_id` = a.`workspace_id`
			WHERE a.`user_id` = s.`owner_user_id` AND b.`user_id` = s.`viewer_user_id`
		);
	DELETE FROM `location_shares`
	WHERE (`owner_user_id` = OLD.`user_id` OR `viewer_user_id` = OLD.`user_id`)
		AND NOT EXISTS (
			SELECT 1 FROM `memberships` AS a
			INNER JOIN `memberships` AS b ON b.`workspace_id` = a.`workspace_id`
			WHERE a.`user_id` = `location_shares`.`owner_user_id` AND b.`user_id` = `location_shares`.`viewer_user_id`
		);
END;
