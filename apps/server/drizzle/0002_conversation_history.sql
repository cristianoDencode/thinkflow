ALTER TABLE `conversations` ADD `pinned` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `conversations` ADD `parent_conversation_id` text;--> statement-breakpoint
ALTER TABLE `conversations` ADD `forked_from_message_id` text;--> statement-breakpoint
ALTER TABLE `conversations` ADD `summary` text;--> statement-breakpoint
ALTER TABLE `conversations` ADD `summary_through_message_id` text;--> statement-breakpoint
ALTER TABLE `conversations` ADD `summary_kind` text;--> statement-breakpoint
ALTER TABLE `conversations` ADD `summary_updated_at` integer;--> statement-breakpoint
ALTER TABLE `conversations` ADD `agent_cwd` text;--> statement-breakpoint
ALTER TABLE `conversations` ADD `agent_permission_mode` text;--> statement-breakpoint
CREATE INDEX `conversations_updated_idx` ON `conversations` (`updated_at`);