CREATE TABLE `share_kv_policies` (
	`share_id` text NOT NULL,
	`collection` text NOT NULL,
	`read_mode` text DEFAULT 'all' NOT NULL,
	`write_mode` text DEFAULT 'all' NOT NULL,
	`delete_mode` text DEFAULT 'all' NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`share_id`, `collection`),
	FOREIGN KEY (`share_id`) REFERENCES `shares`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `share_kv` ADD `creator_key` text;--> statement-breakpoint
ALTER TABLE `shares` ADD `data_generation` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `shares` ADD `data_schema_version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `shares` ADD `comments_visitor_write` integer DEFAULT true NOT NULL;