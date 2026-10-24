CREATE TABLE `share_attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`share_id` text NOT NULL,
	`creator_key` text NOT NULL,
	`original_name` text NOT NULL,
	`mime_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`visibility` text DEFAULT 'private' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`share_id`) REFERENCES `shares`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `share_attachments_share_idx` ON `share_attachments` (`share_id`);--> statement-breakpoint
CREATE INDEX `share_attachments_creator_idx` ON `share_attachments` (`share_id`,`creator_key`);--> statement-breakpoint
ALTER TABLE `shares` ADD `attachments_enabled` integer DEFAULT false NOT NULL;