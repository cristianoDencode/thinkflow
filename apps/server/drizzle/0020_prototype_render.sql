ALTER TABLE `prototypes` ADD `rendered_version_id` text;--> statement-breakpoint
ALTER TABLE `prototypes` ADD `rendered_at` integer;--> statement-breakpoint
ALTER TABLE `prototypes` ADD `rendered_scale` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `prototypes` ADD `sent_to` text DEFAULT '[]' NOT NULL;