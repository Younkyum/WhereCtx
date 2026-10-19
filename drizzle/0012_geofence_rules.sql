ALTER TABLE `places` ADD `polygon` text;--> statement-breakpoint
ALTER TABLE `places` ADD `enter_after_sec` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `places` ADD `exit_after_sec` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `places` ADD `approach_m` real;--> statement-breakpoint
ALTER TABLE `places` ADD `emits` text;--> statement-breakpoint
ALTER TABLE `places` ADD `notify_webhooks` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `places` ADD `notify_reminders` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `presence` ADD `pending_exit_since` text;--> statement-breakpoint
ALTER TABLE `presence` ADD `pending_place_name` text;--> statement-breakpoint
ALTER TABLE `presence` ADD `pending_place_since` text;--> statement-breakpoint
ALTER TABLE `presence` ADD `approached_places` text;--> statement-breakpoint
ALTER TABLE `presence_events` ADD `webhook` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `webhooks` ADD `places` text;