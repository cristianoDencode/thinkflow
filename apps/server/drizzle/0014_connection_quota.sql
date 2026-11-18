CREATE TABLE `connection_quota` (
	`connection_id` text NOT NULL,
	`metric` text NOT NULL,
	`quota_window` text NOT NULL,
	`quota_limit` integer NOT NULL,
	`remaining` integer,
	`used` integer,
	`reset_at` integer,
	`model` text,
	`source` text NOT NULL,
	`observed_at` integer NOT NULL,
	PRIMARY KEY(`connection_id`, `metric`, `quota_window`)
);
