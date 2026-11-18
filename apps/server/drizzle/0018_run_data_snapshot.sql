ALTER TABLE `test_runs` ADD `seq` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `test_runs` ADD `rerun_of` text;--> statement-breakpoint
ALTER TABLE `test_runs` ADD `data_snapshot` text;--> statement-breakpoint
ALTER TABLE `test_runs` ADD `data_secrets_enc` text DEFAULT '' NOT NULL;--> statement-breakpoint
-- Runs already stored are numbered by age inside their session (1 = the oldest). Their data was not
-- kept: `data_snapshot` stays NULL and a reproduction falls back to the data set's current values.
UPDATE `test_runs` SET `seq` = (
  SELECT count(*) FROM `test_runs` r2
  WHERE r2.`session_id` = `test_runs`.`session_id`
    AND (r2.`created_at` < `test_runs`.`created_at`
      OR (r2.`created_at` = `test_runs`.`created_at` AND r2.`id` <= `test_runs`.`id`))
);
