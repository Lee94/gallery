CREATE TABLE `share_blobs` (
	`sha256` text PRIMARY KEY NOT NULL,
	`size_bytes` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `share_comment_bans` (
	`share_id` text NOT NULL,
	`visitor_key` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`share_id`, `visitor_key`),
	FOREIGN KEY (`share_id`) REFERENCES `shares`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `share_comments` (
	`id` text PRIMARY KEY NOT NULL,
	`share_id` text NOT NULL,
	`visitor_key` text,
	`author_label` text DEFAULT '访客' NOT NULL,
	`body` text NOT NULL,
	`is_owner` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`created_at` integer NOT NULL,
	`resolved_at` integer,
	FOREIGN KEY (`share_id`) REFERENCES `shares`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `share_comments_share_idx` ON `share_comments` (`share_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `share_kv` (
	`share_id` text NOT NULL,
	`collection` text NOT NULL,
	`key` text NOT NULL,
	`value_json` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`size_bytes` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`share_id`, `collection`, `key`),
	FOREIGN KEY (`share_id`) REFERENCES `shares`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `share_kv_share_coll_idx` ON `share_kv` (`share_id`,`collection`);--> statement-breakpoint
CREATE TABLE `share_llm_usage` (
	`id` text PRIMARY KEY NOT NULL,
	`share_id` text NOT NULL,
	`visitor_key` text,
	`tokens_in` integer NOT NULL,
	`tokens_out` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`share_id`) REFERENCES `shares`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `share_llm_usage_share_idx` ON `share_llm_usage` (`share_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `share_llm_usage_visitor_idx` ON `share_llm_usage` (`visitor_key`,`created_at`);--> statement-breakpoint
CREATE TABLE `share_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`share_id` text NOT NULL,
	`version_no` integer NOT NULL,
	`label` text,
	`manifest` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`share_id`) REFERENCES `shares`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `share_versions_share_version_uniq` ON `share_versions` (`share_id`,`version_no`);--> statement-breakpoint
ALTER TABLE `shares` ADD `kv_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `shares` ADD `comments_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `shares` ADD `llm_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `shares` ADD `llm_daily_token_budget` integer;--> statement-breakpoint
ALTER TABLE `shares` ADD `llm_model` text;