CREATE TABLE `ai_column_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`connection_id` text NOT NULL,
	`schema_name` text NOT NULL,
	`table_name` text NOT NULL,
	`column_name` text NOT NULL,
	`action` text NOT NULL,
	`kind` text,
	`origin` text DEFAULT 'analyst' NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`connection_id`) REFERENCES `database_connections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ai_column_rules_uq` ON `ai_column_rules` (`connection_id`,`schema_name`,`table_name`,`column_name`);--> statement-breakpoint
CREATE INDEX `ai_column_rules_column_idx` ON `ai_column_rules` (`connection_id`,`column_name`);--> statement-breakpoint
CREATE TABLE `pii_vault` (
	`scope_id` text NOT NULL,
	`token` text NOT NULL,
	`kind` text NOT NULL,
	`value_cipher` text NOT NULL,
	`value_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`scope_id`, `token`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pii_vault_hash_uq` ON `pii_vault` (`scope_id`,`value_hash`);--> statement-breakpoint
-- Legacy per-connection lists become wildcard rules ('*' schema and table). The old columns stay
-- (read as a fallback for one version). `reveal` is inserted last so it wins over `tokenize`.
INSERT INTO `ai_column_rules` (`id`, `connection_id`, `schema_name`, `table_name`, `column_name`, `action`, `kind`, `origin`, `updated_at`)
SELECT lower(hex(randomblob(16))), c.`id`, '*', '*', lower(trim(j.`value`)), 'tokenize', NULL, 'analyst', c.`updated_at`
FROM `database_connections` c,
  json_each(CASE WHEN json_valid(c.`sensitive_columns`) THEN c.`sensitive_columns` ELSE '[]' END) j
WHERE j.`type` = 'text' AND trim(j.`value`) <> ''
ON CONFLICT (`connection_id`, `schema_name`, `table_name`, `column_name`) DO NOTHING;
--> statement-breakpoint
INSERT INTO `ai_column_rules` (`id`, `connection_id`, `schema_name`, `table_name`, `column_name`, `action`, `kind`, `origin`, `updated_at`)
SELECT lower(hex(randomblob(16))), c.`id`, '*', '*', lower(trim(j.`value`)), 'reveal', NULL, 'analyst', c.`updated_at`
FROM `database_connections` c,
  json_each(CASE WHEN json_valid(c.`reveal_columns`) THEN c.`reveal_columns` ELSE '[]' END) j
WHERE j.`type` = 'text' AND trim(j.`value`) <> ''
ON CONFLICT (`connection_id`, `schema_name`, `table_name`, `column_name`) DO UPDATE SET `action` = 'reveal';
