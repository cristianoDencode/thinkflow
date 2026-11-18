ALTER TABLE `reports` ADD `html_hash` text;--> statement-breakpoint
ALTER TABLE `reports` ADD `artifacts_stored_at` integer;--> statement-breakpoint
ALTER TABLE `reports` ADD `storage_attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `reports` ADD `storage_next_at` integer;--> statement-breakpoint
ALTER TABLE `reports` ADD `storage_error` text;--> statement-breakpoint
CREATE INDEX `reports_storage_idx` ON `reports` (`status`,`artifacts_stored_at`);