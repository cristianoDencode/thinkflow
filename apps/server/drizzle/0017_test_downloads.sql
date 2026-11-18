CREATE TABLE `test_downloads` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`step_id` text,
	`run_id` text,
	`source` text NOT NULL,
	`file_name` text NOT NULL,
	`size` integer DEFAULT 0 NOT NULL,
	`content_type` text DEFAULT 'application/octet-stream' NOT NULL,
	`url` text DEFAULT '' NOT NULL,
	`status` text NOT NULL,
	`reason` text,
	`object_key` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `test_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `test_downloads_session_idx` ON `test_downloads` (`session_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `test_downloads_run_idx` ON `test_downloads` (`run_id`);