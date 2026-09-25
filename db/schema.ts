import { sql } from "drizzle-orm";
import { text, sqliteTable } from "drizzle-orm/sqlite-core";

export const dashboardState = sqliteTable("dashboard_state", {
  id: text("id").primaryKey(),
  fileName: text("file_name").notNull(),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  objectKey: text("object_key"),
  workbookJson: text("workbook_json"),
});
