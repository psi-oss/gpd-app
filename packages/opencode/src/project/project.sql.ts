import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../storage/schema.sql"
import type { ProjectID } from "./schema"

export const ProjectTable = sqliteTable("project", {
  id: text().$type<ProjectID>().primaryKey(),
  worktree: text().notNull(),
  vcs: text(),
  name: text(),
  icon_url: text(),
  icon_color: text(),
  // RES-1010: user-chosen 1-2 character glyph shown in place of the
  // auto-derived first-letter when multiple projects share the same
  // starting character (e.g. "Cosmological Constant" and "Compactification"
  // both default to "C"). When null, the sidebar falls back to the
  // first grapheme of `name` exactly as before.
  icon_character: text(),
  ...Timestamps,
  time_initialized: integer(),
  sandboxes: text({ mode: "json" }).notNull().$type<string[]>(),
  commands: text({ mode: "json" }).$type<{ start?: string }>(),
})
