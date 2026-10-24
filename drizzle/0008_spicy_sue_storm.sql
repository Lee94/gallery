ALTER TABLE `shares` ADD `runtime` text DEFAULT 'static' NOT NULL;--> statement-breakpoint
ALTER TABLE `shares` ADD `runtime_version` text DEFAULT '19.3.1' NOT NULL;