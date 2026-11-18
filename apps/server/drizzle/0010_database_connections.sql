CREATE TABLE `database_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`host` text NOT NULL,
	`port` integer NOT NULL,
	`database` text NOT NULL,
	`user` text NOT NULL,
	`password_enc` text DEFAULT '' NOT NULL,
	`ssl_mode` text DEFAULT 'disable' NOT NULL,
	`schemas` text DEFAULT '[]' NOT NULL,
	`ai_access` text DEFAULT 'schema' NOT NULL,
	`sample_rows` integer DEFAULT 20 NOT NULL,
	`sensitive_columns` text DEFAULT '[]' NOT NULL,
	`reveal_columns` text DEFAULT '[]' NOT NULL,
	`statement_timeout_sec` integer DEFAULT 30 NOT NULL,
	`max_rows` integer DEFAULT 1000 NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `database_connections_name_unique` ON `database_connections` (`name`);--> statement-breakpoint
ALTER TABLE `conversations` ADD `database_id` text;