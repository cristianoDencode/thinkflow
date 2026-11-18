ALTER TABLE `prototype_blocks` ADD `source` text;--> statement-breakpoint
ALTER TABLE `prototypes` ADD `kind` text DEFAULT 'prototype' NOT NULL;--> statement-breakpoint
CREATE INDEX `prototypes_kind_idx` ON `prototypes` (`kind`);