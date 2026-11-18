CREATE TABLE `libraries` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`engine` text DEFAULT 'local' NOT NULL,
	`remote_notebook_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `libraries_name_unique` ON `libraries` (`name`);--> statement-breakpoint
CREATE TABLE `library_chunks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`document_id` text NOT NULL,
	`library_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`text` text NOT NULL,
	`heading` text,
	`page_from` integer,
	`page_to` integer,
	`token_estimate` integer NOT NULL,
	FOREIGN KEY (`document_id`) REFERENCES `library_documents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `library_chunks_doc_idx` ON `library_chunks` (`document_id`,`ordinal`);--> statement-breakpoint
CREATE INDEX `library_chunks_lib_idx` ON `library_chunks` (`library_id`);--> statement-breakpoint
CREATE TABLE `library_documents` (
	`id` text PRIMARY KEY NOT NULL,
	`library_id` text NOT NULL,
	`name` text NOT NULL,
	`mime_type` text NOT NULL,
	`kind` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`sha256` text NOT NULL,
	`status` text DEFAULT 'processing' NOT NULL,
	`error` text,
	`extraction` text,
	`page_count` integer,
	`char_count` integer DEFAULT 0 NOT NULL,
	`chunk_count` integer DEFAULT 0 NOT NULL,
	`storage_key` text NOT NULL,
	`remote_source_id` text,
	`remote_status` text,
	`remote_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`library_id`) REFERENCES `libraries`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `library_documents_hash_uq` ON `library_documents` (`library_id`,`sha256`);--> statement-breakpoint
CREATE INDEX `library_documents_library_idx` ON `library_documents` (`library_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `library_documents_status_idx` ON `library_documents` (`status`);--> statement-breakpoint
ALTER TABLE `conversations` ADD `library_id` text;