ALTER TABLE `presence` ADD `area_lat` real;--> statement-breakpoint
ALTER TABLE `presence` ADD `area_lon` real;--> statement-breakpoint
ALTER TABLE `presence` ADD `moved_at` text;--> statement-breakpoint
ALTER TABLE `presence` ADD `moved_lat` real;--> statement-breakpoint
ALTER TABLE `presence` ADD `moved_lon` real;--> statement-breakpoint
ALTER TABLE `privacy_settings` ADD `area_on_home` integer DEFAULT true NOT NULL;