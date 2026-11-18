CREATE TABLE `test_evidences` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`step_id` text,
	`seq` integer NOT NULL,
	`at` integer NOT NULL,
	`width` integer NOT NULL,
	`height` integer NOT NULL,
	`original_key` text NOT NULL,
	`annotated_key` text,
	`annotations` text DEFAULT '[]' NOT NULL,
	`comment` text DEFAULT '' NOT NULL,
	`include` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `test_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `test_evidences_session_idx` ON `test_evidences` (`session_id`,`seq`);--> statement-breakpoint
CREATE TABLE `test_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`data_set_id` text,
	`status` text NOT NULL,
	`headed` integer DEFAULT false NOT NULL,
	`results` text DEFAULT '[]' NOT NULL,
	`error` text,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	FOREIGN KEY (`session_id`) REFERENCES `test_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `test_runs_session_idx` ON `test_runs` (`session_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `test_runs_status_idx` ON `test_runs` (`status`);--> statement-breakpoint
CREATE TABLE `test_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`start_url` text NOT NULL,
	`definition` text NOT NULL,
	`secrets_enc` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `test_sessions_updated_idx` ON `test_sessions` (`updated_at`);