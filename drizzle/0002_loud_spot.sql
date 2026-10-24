CREATE TABLE `share_page_states` (
	`share_id` text PRIMARY KEY NOT NULL,
	`data_json` text DEFAULT 'null' NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	`size_bytes` integer DEFAULT 4 NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`share_id`) REFERENCES `shares`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `shares` ADD `page_state_enabled` integer DEFAULT false NOT NULL;