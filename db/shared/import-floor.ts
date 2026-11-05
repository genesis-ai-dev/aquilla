// AQU-2305: who may bring a NEW source file into ONE project — the org's
// import floor (AQU-2304), which a project may make STRICTER and never looser.
//
// The org keeps `importMinRole` in its settings blob (Project lead when unset,
// AQU-2304). A project may store the same key in its own settings blob. The
// floor a project enforces is the HIGHER of the two, so a project value at or
// below the org's is inert: one written before the org raised its floor, or one
// that reached the blob around the settings route, can never open an import the
// org closed.
//
// Decision (Matthew, 2026-10-30): stricter-only, not a free override. A
// project's settings are maintainer-writable while the org's floor is
// owner-only, so a free override would let a project maintainer undo an
// owner's policy.
//
// The stricter-only arithmetic is the same as the roster/member-progress
// visibility floors (./visibility-floors.ts) — only the key and the org-side
// default differ — so this module borrows `stricterProjectFloor` rather than
// restating it. Shared by both workers so the auth-worker's settings response
// and the sync-worker's `file.create` perimeter can never disagree about the
// floor one project enforces.
//
// AQU-2306: the org's Security page also COUNTS and NAMES the projects that
// require more than the org does ("N projects are stricter than this"). That
// read comes off the `wp_import_min_role` projection migration 0192 added for
// the perimeter, never off the settings blob — see `loadOrgProjectImportFloors`
// below. Nothing there authorizes anything; the import gate itself lives in
// sync-worker (events/import-authority.ts).

import type { AquillaDb } from "../shim/postgres"
import { stricterProjectFloor } from "./visibility-floors"

/** The settings key, the same one the org uses (AQU-2304). */
export const IMPORT_MIN_ROLE_KEY = "importMinRole"

/**
 * The project's own value where STRICTER than the org's, else null ("follows
 * the organization"). Null is what the Project Settings row renders as
 * "Organization default (…)", so an inert stored value must read as null here
 * and not as "this project set its own".
 */
export function stricterProjectImportFloor(orgFloor: number, projectRaw: unknown): number | null {
  return stricterProjectFloor(orgFloor, projectRaw)
}

/** The floor a project enforces: the org's, raised by the project's own value. */
export function effectiveImportFloor(orgFloor: number, projectRaw: unknown): number {
  return stricterProjectImportFloor(orgFloor, projectRaw) ?? orgFloor
}

/** One project's import floor as every surface reports it. */
export interface ImportFloorView {
  /** The org's floor, defaults applied. */
  org: number
  /** The project's own value where stricter, else null. */
  project: number | null
  /** The floor actually enforced — the higher of the two. */
  effective: number
}

export function importFloorView(orgFloor: number, projectRaw: unknown): ImportFloorView {
  const project = stricterProjectImportFloor(orgFloor, projectRaw)
  return { org: orgFloor, project, effective: project ?? orgFloor }
}

/** One live project's own import floor, as the org's stricter line reads it. */
export interface OrgProjectImportFloorRow {
  projectId: string
  /** The line names the projects, not only counts them (AQU-1938's shape). */
  name: string
  /** Whether the caller may see this project's name (the rule the caller passed in). */
  nameVisible: boolean
  /** The project's own value, null when it holds no JSON number. */
  importMinRole: number | null
}

/**
 * AQU-2306: every live (unarchived) project in an org that stores its own
 * import floor as a NUMBER. Projects that follow the org are left out by the
 * WHERE, so a project that never touched the setting costs nothing. Ordered by
 * name, as the list shows them.
 *
 * The value comes from the STORED generated column migration 0192 added
 * (`wp_import_min_role`, AQU-2305), never from the settings blob: that can run
 * to megabytes, and this read walks every project in the org. The column is
 * JSONB, so `jsonb_typeof` tells the number 600 from the string "600" — a
 * floor read off a string would be a permission decided by a typo, which is
 * why anything but a number is left out here rather than coerced.
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
              ps.wp_import_min_role AS import_min_role,
              p.name AS name,
              CASE WHEN ${nameVisible.sql} THEN 1 ELSE 0 END AS name_visible
         FROM projects p
         JOIN project_settings ps ON ps.project_id = p.id
        WHERE p.org_id = ? AND p.archived_at IS NULL
          AND jsonb_typeof(ps.wp_import_min_role) = 'number'
        ORDER BY LOWER(p.name), p.id`,
    )
    .bind(...nameVisible.binds, orgId)
    .all<{ project_id: string; import_min_role: number | string | null; name: string; name_visible: number | string }>()
  // JSONB arrives parsed (a JS number); `Number` also covers a driver that
  // hands the JSON text back.
  return (results ?? []).map((row) => ({
    projectId: row.project_id,
    name: row.name,
    nameVisible: Number(row.name_visible) === 1,
    importMinRole: row.import_min_role == null ? null : Number(row.import_min_role),
  }))
}
