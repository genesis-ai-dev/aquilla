// AQU-2306: which of an org's projects require MORE than the org does to bring
// a new source file in.
//
// The org keeps `importMinRole` in its settings blob (AQU-2304, Project lead
// when unset) and a project may store the same key in its own blob to make the
// floor stricter, never looser (AQU-2305) — exactly the direction the two
// visibility floors take, so the comparison itself is `stricterProjectFloor`
// rather than a second copy of the same arithmetic. What differs is only what
// the floor governs: these are read-visibility floors, this is a write gate,
// and the import gate itself lives in sync-worker (events/import-authority.ts).
// Nothing here authorizes anything — it answers the org Security page's
// "N projects are stricter than this" line, and names them.

import type { AquillaDb } from "../shim/postgres"
import { stricterProjectFloor } from "./visibility-floors"

/** One live project's own import floor, as the org's stricter line reads it. */
export interface OrgProjectImportFloorRow {
  projectId: string
  /** The line names the projects, not only counts them (AQU-1938's shape). */
  name: string
  /** Whether the caller may see this project's name (the rule the caller passed in). */
  nameVisible: boolean
  /** The project's own value, null when it holds no role-ladder number. */
  importMinRole: number | null
}

/**
 * Every live (unarchived) project in an org that stores its own import floor.
 * Projects that follow the org are left out by the WHERE, so a project that
 * never touched the setting costs nothing. Ordered by name, as the list shows
 * them.
 *
 * The value comes from the STORED generated column migration 0192 added
 * (`import_min_role`), never from the settings blob: that can run to
 * megabytes, and this read walks every project in the org.
 *
 * `nameVisible` is a condition over `projects p` saying whether the CALLER may
 * see a project's name, with its binds in order — the same contract
 * `loadOrgProjectVisibilityOverrides` takes. Every row still comes back, so
 * the count covers projects the caller cannot see; those are flagged and left
 * to "and N more".
 */
export async function loadOrgProjectImportFloors(
  db: AquillaDb,
  orgId: number,
  nameVisible: { sql: string; binds: readonly unknown[] },
): Promise<OrgProjectImportFloorRow[]> {
  const { results } = await db
    .prepare(
      `SELECT ps.project_id AS project_id,
              ps.import_min_role AS import_min_role,
              p.name AS name,
              CASE WHEN ${nameVisible.sql} THEN 1 ELSE 0 END AS name_visible
         FROM projects p
         JOIN project_settings ps ON ps.project_id = p.id
        WHERE p.org_id = ? AND p.archived_at IS NULL
          AND ps.import_min_role IS NOT NULL
        ORDER BY LOWER(p.name), p.id`,
    )
    .bind(...nameVisible.binds, orgId)
    .all<{ project_id: string; import_min_role: string | null; name: string; name_visible: number | string }>()
  return (results ?? []).map((row) => ({
    projectId: row.project_id,
    name: row.name,
    nameVisible: Number(row.name_visible) === 1,
    importMinRole: row.import_min_role == null ? null : Number(row.import_min_role),
  }))
}

/**
 * The project's own import floor when it is STRICTER than the org's, else null.
 * A value at or below the org's is inert — the project follows its org — so it
 * must not read as "this project is stricter", and the count must fall back to
 * zero when the ORG rises past it, with no write to the project.
 */
export function stricterProjectImportFloor(orgFloor: number, projectRaw: unknown): number | null {
  return stricterProjectFloor(orgFloor, projectRaw)
}
