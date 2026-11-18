CREATE TABLE `onedrive_account` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text DEFAULT '' NOT NULL,
	`client_secret_enc` text DEFAULT '' NOT NULL,
	`redirect_uri_override` text DEFAULT '' NOT NULL,
	`naming_pattern` text DEFAULT 'CT {ticketId} - {title}.docx' NOT NULL,
	`default_folder_id` text,
	`default_folder_name` text,
	`default_folder_path` text,
	`state` text DEFAULT 'disconnected' NOT NULL,
	`account_id` text,
	`account_name` text,
	`account_email` text,
	`access_token_enc` text DEFAULT '' NOT NULL,
	`refresh_token_enc` text DEFAULT '' NOT NULL,
	`access_token_expires_at` integer,
	`connected_at` integer,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `onedrive_auth_requests` (
	`state` text PRIMARY KEY NOT NULL,
	`code_verifier_enc` text NOT NULL,
	`redirect_uri` text NOT NULL,
	`created_at` integer NOT NULL
);
