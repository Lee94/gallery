CREATE TABLE `share_files` (
	`share_id` text NOT NULL,
	`path` text NOT NULL,
	`mime_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`share_id`, `path`),
	FOREIGN KEY (`share_id`) REFERENCES `shares`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `share_visitor_states` (
	`share_id` text NOT NULL,
	`visitor_key` text NOT NULL,
	`data_json` text DEFAULT 'null' NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	`size_bytes` integer DEFAULT 4 NOT NULL,
	`updated_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`share_id`, `visitor_key`),
	FOREIGN KEY (`share_id`) REFERENCES `shares`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `share_visitor_states_share_id_idx` ON `share_visitor_states` (`share_id`);--> statement-breakpoint
ALTER TABLE `shares` ADD `entry_path` text DEFAULT 'index.html' NOT NULL;--> statement-breakpoint
ALTER TABLE `shares` ADD `visitor_state_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `shares` ADD `updated_at` integer NOT NULL DEFAULT 0;--> statement-breakpoint
UPDATE `shares` SET `updated_at` = `created_at` WHERE `updated_at` = 0;--> statement-breakpoint
-- 存量 share：原始文件名即磁盘文件名（无扩展名），现在统一落到 index.html；
-- share_files 清单同步插入一行，使 /api/raw/<slug>/index.html 与 /s/<slug> 都能访问。
INSERT INTO `share_files` (`share_id`, `path`, `mime_type`, `size_bytes`, `created_at`, `updated_at`)
SELECT `id`, 'index.html', `mime_type`, `size`, `created_at`, `created_at` FROM `shares`;