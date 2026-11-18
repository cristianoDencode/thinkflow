-- A step has at most one image ("prints live in the steps"). Older sessions could hold several
-- evidences for the same step: the first one (by seq) keeps the step, the others are unlinked so
-- the unique index below can be created. Nothing is deleted: the boot-time data migration
-- (migrateLegacyStepImages) turns every unlinked evidence into a `capture` step and moves the old
-- per-step thumbnails into step images.
UPDATE `test_evidences` SET `step_id` = NULL
WHERE `step_id` IS NOT NULL
  AND `id` <> (
    SELECT e2.`id` FROM `test_evidences` e2
    WHERE e2.`session_id` = `test_evidences`.`session_id` AND e2.`step_id` = `test_evidences`.`step_id`
    ORDER BY e2.`seq`, e2.`id` LIMIT 1
  );--> statement-breakpoint
CREATE UNIQUE INDEX `test_evidences_step_unique` ON `test_evidences` (`step_id`);
