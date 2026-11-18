CREATE TABLE `prototype_blocks` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`category` text NOT NULL,
	`html` text NOT NULL,
	`css` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `prototype_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`prototype_id` text NOT NULL,
	`seq` integer NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`width` integer NOT NULL,
	`height` integer NOT NULL,
	`bytes` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`prototype_id`) REFERENCES `prototypes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `prototype_versions_seq_idx` ON `prototype_versions` (`prototype_id`,`seq`);--> statement-breakpoint
CREATE TABLE `prototypes` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`session_id` text,
	`step_id` text,
	`source` text DEFAULT '{}' NOT NULL,
	`width` integer NOT NULL,
	`height` integer NOT NULL,
	`scrubbed` integer DEFAULT false NOT NULL,
	`current_version_id` text NOT NULL,
	`thumbnail_key` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `test_sessions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `prototypes_session_idx` ON `prototypes` (`session_id`);--> statement-breakpoint
CREATE INDEX `prototypes_updated_idx` ON `prototypes` (`updated_at`);