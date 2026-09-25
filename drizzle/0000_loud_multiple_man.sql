CREATE TABLE `dashboard_state` (
	`id` text PRIMARY KEY NOT NULL,
	`file_name` text NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`workbook_json` text NOT NULL
);
