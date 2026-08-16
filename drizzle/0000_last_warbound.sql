CREATE TABLE `files` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`parent_id` integer,
	`is_folder` integer DEFAULT false NOT NULL,
	`mime_type` text DEFAULT 'application/octet-stream' NOT NULL,
	`size` integer DEFAULT 0 NOT NULL,
	`lifecycle_status` text DEFAULT 'PENDING' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_accessed_at` integer,
	`last_downloaded_at` integer,
	`trashed_at` integer,
	FOREIGN KEY (`parent_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `idx_files_parent_id` ON `files` (`parent_id`);--> statement-breakpoint
CREATE INDEX `idx_files_lifecycle_status` ON `files` (`lifecycle_status`);--> statement-breakpoint
CREATE INDEX `idx_files_name` ON `files` (`name`);--> statement-breakpoint
CREATE TABLE `google_accounts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`email` text NOT NULL,
	`display_name` text NOT NULL,
	`total_space` integer DEFAULT 0 NOT NULL,
	`used_space` integer DEFAULT 0 NOT NULL,
	`free_space` integer DEFAULT 0 NOT NULL,
	`reserved_bytes` integer DEFAULT 0 NOT NULL,
	`migration_locked` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'AVAILABLE' NOT NULL,
	`encrypted_credentials` text NOT NULL,
	`last_synced_at` integer,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `google_accounts_email_unique` ON `google_accounts` (`email`);--> statement-breakpoint
CREATE INDEX `idx_google_accounts_status` ON `google_accounts` (`status`);--> statement-breakpoint
CREATE INDEX `idx_google_accounts_email` ON `google_accounts` (`email`);--> statement-breakpoint
CREATE TABLE `file_locations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`file_id` integer NOT NULL,
	`google_account_id` integer NOT NULL,
	`provider_file_id` text NOT NULL,
	`status` text DEFAULT 'COPYING' NOT NULL,
	`size` integer NOT NULL,
	`mime_type` text DEFAULT 'application/octet-stream' NOT NULL,
	`checksum` text,
	`checksum_type` text,
	`created_at` integer NOT NULL,
	`migrated_at` integer,
	FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`google_account_id`) REFERENCES `google_accounts`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `idx_file_locations_file_id` ON `file_locations` (`file_id`);--> statement-breakpoint
CREATE INDEX `idx_file_locations_google_account_id` ON `file_locations` (`google_account_id`);--> statement-breakpoint
CREATE INDEX `idx_file_locations_status` ON `file_locations` (`status`);--> statement-breakpoint
CREATE INDEX `idx_file_locations_file_status` ON `file_locations` (`file_id`,`status`);--> statement-breakpoint
CREATE TABLE `storage_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`operation_type` text NOT NULL,
	`file_id` integer,
	`source_drive_id` integer,
	`dest_drive_id` integer,
	`requested_bytes` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'PENDING' NOT NULL,
	`error_code` text,
	`error_message` text,
	`plan_context` text,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`completed_at` integer,
	FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`source_drive_id`) REFERENCES `google_accounts`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`dest_drive_id`) REFERENCES `google_accounts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_storage_operations_status` ON `storage_operations` (`status`);--> statement-breakpoint
CREATE INDEX `idx_storage_operations_type` ON `storage_operations` (`operation_type`);--> statement-breakpoint
CREATE INDEX `idx_storage_operations_file_id` ON `storage_operations` (`file_id`);--> statement-breakpoint
CREATE TABLE `storage_reservations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`google_account_id` integer NOT NULL,
	`operation_id` text NOT NULL,
	`reserved_bytes` integer NOT NULL,
	`status` text DEFAULT 'ACTIVE' NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`google_account_id`) REFERENCES `google_accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`operation_id`) REFERENCES `storage_operations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_reservations_account_status` ON `storage_reservations` (`google_account_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_reservations_operation_id` ON `storage_reservations` (`operation_id`);--> statement-breakpoint
CREATE INDEX `idx_reservations_expires_at` ON `storage_reservations` (`expires_at`);--> statement-breakpoint
CREATE TABLE `file_migrations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`operation_id` text NOT NULL,
	`file_id` integer NOT NULL,
	`source_drive_id` integer NOT NULL,
	`source_provider_file_id` text NOT NULL,
	`dest_drive_id` integer NOT NULL,
	`dest_provider_file_id` text,
	`reason` text NOT NULL,
	`bytes_transferred` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'IN_PROGRESS' NOT NULL,
	`started_at` integer NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`operation_id`) REFERENCES `storage_operations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_drive_id`) REFERENCES `google_accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`dest_drive_id`) REFERENCES `google_accounts`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `idx_migrations_file_id` ON `file_migrations` (`file_id`);--> statement-breakpoint
CREATE INDEX `idx_migrations_operation_id` ON `file_migrations` (`operation_id`);--> statement-breakpoint
CREATE INDEX `idx_migrations_status` ON `file_migrations` (`status`);