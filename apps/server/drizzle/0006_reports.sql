CREATE TABLE `report_notes` (
	`id` text PRIMARY KEY NOT NULL,
	`report_id` text NOT NULL,
	`step` integer NOT NULL,
	`ordinal` integer NOT NULL,
	`source` text NOT NULL,
	`tool_name` text,
	`query` text,
	`content` text NOT NULL,
	`section_hints` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`report_id`) REFERENCES `reports`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `report_notes_report_idx` ON `report_notes` (`report_id`,`step`,`ordinal`);--> statement-breakpoint
CREATE TABLE `report_sections` (
	`report_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`title` text NOT NULL,
	`requirements` text DEFAULT '' NOT NULL,
	`role` text DEFAULT 'section' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`markdown` text DEFAULT '' NOT NULL,
	`html` text,
	`note_ids` text DEFAULT '[]' NOT NULL,
	`model` text,
	`provider_id` text,
	`warnings` text DEFAULT '[]' NOT NULL,
	`error` text,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`report_id`, `ordinal`),
	FOREIGN KEY (`report_id`) REFERENCES `reports`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `reports` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`kind` text NOT NULL,
	`template_id` text,
	`template_name` text NOT NULL,
	`template_snapshot` text NOT NULL,
	`status` text NOT NULL,
	`progress` text NOT NULL,
	`error` text,
	`failed_phase` text,
	`cancel_requested` integer DEFAULT false NOT NULL,
	`model` text NOT NULL,
	`variables` text DEFAULT '{}' NOT NULL,
	`brief` text DEFAULT '' NOT NULL,
	`library_id` text,
	`use_mcp` integer DEFAULT false NOT NULL,
	`conversation_id` text,
	`plan` text,
	`research_done` integer DEFAULT 0 NOT NULL,
	`outline` text,
	`html` text,
	`markdown` text,
	`meta` text DEFAULT '{}' NOT NULL,
	`pdf_key` text,
	`pdf_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`started_at` integer,
	`finished_at` integer
);
--> statement-breakpoint
CREATE INDEX `reports_status_idx` ON `reports` (`status`);--> statement-breakpoint
CREATE INDEX `reports_created_idx` ON `reports` (`created_at`);