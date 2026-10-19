CREATE TABLE `geo_cache` (
	`user_id` text NOT NULL,
	`provider` text NOT NULL,
	`cell` text NOT NULL,
	`result` text,
	`created_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `provider`, `cell`)
);
--> statement-breakpoint
CREATE INDEX `geo_cache_created_at_idx` ON `geo_cache` (`created_at`);--> statement-breakpoint
CREATE TABLE `geo_credentials` (
	`user_id` text NOT NULL,
	`provider` text NOT NULL,
	`secret` text NOT NULL,
	`hint` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`last_used_at` text,
	`last_error` text,
	PRIMARY KEY(`user_id`, `provider`)
);
--> statement-breakpoint
ALTER TABLE `location_shares` ADD `show_area` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `privacy_settings` ADD `geo_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `privacy_settings` ADD `area_to_agents` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `privacy_settings` ADD `area_to_people` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `privacy_settings` ADD `eta_to_agents` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `privacy_settings` ADD `skip_provider_near_home` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `privacy_settings` ADD `geo_provider` text;--> statement-breakpoint
ALTER TABLE `share_audit` ADD `before_show_area` integer;--> statement-breakpoint
ALTER TABLE `share_audit` ADD `after_show_area` integer;--> statement-breakpoint
DROP TRIGGER `memberships_end_orphaned_shares`;--> statement-breakpoint
CREATE TRIGGER `memberships_end_orphaned_shares` AFTER DELETE ON `memberships`
BEGIN
	INSERT INTO `share_audit` (`id`, `owner_user_id`, `viewer_user_id`, `action`, `reason`, `before_level`, `after_level`, `before_hide_home`, `after_hide_home`, `before_show_area`, `after_show_area`, `created_at`)
	SELECT lower(hex(randomblob(16))), s.`owner_user_id`, s.`viewer_user_id`, 'revoked', 'membership_ended', s.`level`, NULL, s.`hide_home_exact`, NULL, s.`show_area`, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
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
