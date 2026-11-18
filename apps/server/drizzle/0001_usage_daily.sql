CREATE TABLE `usage_daily` (
	`day` text NOT NULL,
	`provider_id` text NOT NULL,
	`model` text NOT NULL,
	`source` text NOT NULL,
	`requests` integer DEFAULT 0 NOT NULL,
	`failures` integer DEFAULT 0 NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`estimated_requests` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`day`, `provider_id`, `model`, `source`)
);
