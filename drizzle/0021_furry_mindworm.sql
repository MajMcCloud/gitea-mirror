CREATE TABLE `storage_release_assets` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`repository_id` text NOT NULL,
	`release_id` integer NOT NULL,
	`release_tag` text DEFAULT '' NOT NULL,
	`release_name` text,
	`release_draft` integer DEFAULT false NOT NULL,
	`release_prerelease` integer DEFAULT false NOT NULL,
	`release_published_at` integer,
	`release_html_url` text,
	`asset_id` integer NOT NULL,
	`asset_uuid` text,
	`file_name` text NOT NULL,
	`size_bytes` integer DEFAULT 0 NOT NULL,
	`download_count` integer DEFAULT 0 NOT NULL,
	`download_url` text,
	`asset_created_at` integer,
	`last_scanned_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_storage_assets_repo_release_asset` ON `storage_release_assets` (`repository_id`,`release_id`,`asset_id`);--> statement-breakpoint
CREATE INDEX `idx_storage_assets_user_id` ON `storage_release_assets` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_storage_assets_repository` ON `storage_release_assets` (`repository_id`);--> statement-breakpoint
CREATE INDEX `idx_storage_assets_size` ON `storage_release_assets` (`user_id`,`size_bytes`);--> statement-breakpoint
CREATE TABLE `storage_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`repository_id` text NOT NULL,
	`config_id` text NOT NULL,
	`captured_at` integer NOT NULL,
	`repository_size_bytes` integer DEFAULT 0 NOT NULL,
	`release_size_bytes` integer DEFAULT 0 NOT NULL,
	`total_size_bytes` integer DEFAULT 0 NOT NULL,
	`release_count` integer DEFAULT 0 NOT NULL,
	`asset_count` integer DEFAULT 0 NOT NULL,
	`total_download_count` integer DEFAULT 0 NOT NULL,
	`collection_status` text DEFAULT 'complete' NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_storage_snapshots_user_captured` ON `storage_snapshots` (`user_id`,`captured_at`);--> statement-breakpoint
CREATE INDEX `idx_storage_snapshots_repo_captured` ON `storage_snapshots` (`repository_id`,`captured_at`);--> statement-breakpoint
CREATE TABLE `storage_states` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`repository_id` text NOT NULL,
	`config_id` text NOT NULL,
	`repository_size_bytes` integer DEFAULT 0 NOT NULL,
	`release_size_bytes` integer DEFAULT 0 NOT NULL,
	`total_size_bytes` integer DEFAULT 0 NOT NULL,
	`release_count` integer DEFAULT 0 NOT NULL,
	`asset_count` integer DEFAULT 0 NOT NULL,
	`total_download_count` integer DEFAULT 0 NOT NULL,
	`largest_asset_size_bytes` integer DEFAULT 0 NOT NULL,
	`collection_status` text DEFAULT 'complete' NOT NULL,
	`last_error` text,
	`last_scanned_at` integer DEFAULT (unixepoch()) NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_storage_states_repository` ON `storage_states` (`repository_id`);--> statement-breakpoint
CREATE INDEX `idx_storage_states_user_id` ON `storage_states` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_storage_states_config_id` ON `storage_states` (`user_id`,`config_id`);