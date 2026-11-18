CREATE TABLE `report_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`built_in` integer DEFAULT false NOT NULL,
	`built_in_version` integer,
	`spec` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `report_templates_kind_name_uq` ON `report_templates` (`kind`,`name`);--> statement-breakpoint
CREATE INDEX `report_templates_kind_idx` ON `report_templates` (`kind`);--> statement-breakpoint
ALTER TABLE `conversations` ADD `preset_kind` text;--> statement-breakpoint
ALTER TABLE `conversations` ADD `preset_template_id` text;