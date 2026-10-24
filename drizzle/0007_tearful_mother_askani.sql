ALTER TABLE `shares` ADD `title` text;--> statement-breakpoint
ALTER TABLE `shares` ADD `description` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `shares` ADD `icon` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `shares` ADD `cover_path` text;--> statement-breakpoint
ALTER TABLE `shares` ADD `source_enabled` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `shares` ADD `pinned` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `shares` ADD `sort_order` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `shares` ADD `forked_from_slug` text;