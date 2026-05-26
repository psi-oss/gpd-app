ALTER TABLE `session_goal` ADD `time_budget` integer;--> statement-breakpoint
ALTER TABLE `session_goal` ADD `cost_budget_micro` integer;--> statement-breakpoint
ALTER TABLE `session_goal` ADD `cost_used_micro` integer DEFAULT 0 NOT NULL;