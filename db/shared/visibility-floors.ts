// AQU-1771: who may see a project's member list (the roster) and each
// member's progress — the org's two visibility floors, which a project may make
// STRICTER and never looser.
//
// The org keeps `rosterViewMinRole` and `memberProgressViewMinRole` in its
// settings blob (AQU-485, Maintainer when unset). A project may store the same
// two keys in its own settings blob. The floor a project enforces is the HIGHER
// of the two, so a project value at or below the org's is inert: one written
// before the org raised its floor, or one that reached the blob around the
// settings route, can never open anything the org closed.
//
// Shared by both workers so every read that names people or shows per-person
// progress resolves a project's floor the same way: the auth-worker routes, the
// org dashboard rollups, and the sync-worker's member-activity read.

import type { AquillaDb } from "../shim/postgres"

export const VISIBILITY_FLOOR_KEYS = ["rosterViewMinRole", "memberProgressViewMinRole"] as const
export type VisibilityFloorKey = (typeof VISIBILITY_FLOOR_KEYS)[number]

/** Both floors default to Maintainer when the org set none (AQU-485). */
export const DEFAULT_VISIBILITY_FLOOR = 600

/** The role ladder: viewer … owner. A project value must be one of these. */
export const VISIBILITY_FLOOR_LEVELS: readonly number[] = [100, 200, 300, 400, 500, 600, 700]

export function isVisibilityFloorKey(key: string): key is VisibilityFloorKey {
  return (VISIBILITY_FLOOR_KEYS as readonly string[]).includes(key)
}

/** A project's stored value when it is a role-ladder level, else null (follows the org). */
export function parseProjectVisibilityFloor(raw: unknown): number | null {
  return typeof raw === "number" && VISIBILITY_FLOOR_LEVELS.includes(raw) ? raw : null
}

/**
 * The org's floor from its settings blob, or the default. Same reading the
 * auth-worker has always applied (`extractRoleFloor`): any finite number in
 * 100..700 is the org's choice.
 */
export function orgVisibilityFloor(
  settings: Readonly<Record<string, unknown>> | null | undefined,
  key: VisibilityFloorKey,
): number {
  const raw = settings?.[key]
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 100 && raw <= 700) return raw
  return DEFAULT_VISIBILITY_FLOOR
}

/**
 * The project's own value when it is STRICTER than the org's, else null. A
 * value at or below the org's floor is inert — the project follows its org —
 * so it must not read as "this project set its own", and must not switch off
 * anything that applies only to a project following its org (the AQU-1308
 * assignee-picker carve-out).
 */
export function stricterProjectFloor(orgFloor: number, projectRaw: unknown): number | null {
  const own = parseProjectVisibilityFloor(projectRaw)
  return own != null && own > orgFloor ? own : null
}

/** The floor a project enforces: the org's, raised by the project's own value. */
export function effectiveVisibilityFloor(orgFloor: number, projectRaw: unknown): number {
  return stricterProjectFloor(orgFloor, projectRaw) ?? orgFloor
}

/** A project's own values, null where it follows the org. */
export interface ProjectVisibilityOverrides {
  rosterViewMinRole: number | null
  memberProgressViewMinRole: number | null
}

const NO_OVERRIDES: ProjectVisibilityOverrides = { rosterViewMinRole: null, memberProgressViewMinRole: null }

/**
 * The own values of the project_settings rows `source` (a FROM … WHERE …
 * clause aliasing project_settings as `ps`) yields.
 *
 * The blob can run to megabytes and there is no column for these keys, so it
 * is parsed only when its text names one of them — almost every project
 * follows its org, and for those the read is a substring scan. The MATERIALIZED
 * CTE is a fence: without it the planner inlines `j` into each CASE below and
 * parses the blob once per reference instead of once per row, and it evaluates
 * the scan only for the rows `source` selects (its own WHERE/JOIN filters run
 * first), never for every project in the table.
 */
function overridesSql(source: string, onlyWithOwnValues = false): string {
  return `WITH s AS MATERIALIZED (
           SELECT ps.project_id AS project_id,
                  CASE WHEN strpos(ps.settings, 'ViewMinRole') > 0 THEN ps.settings::jsonb END AS j
             ${source}
         )
         SELECT project_id,
                CASE WHEN jsonb_typeof(j -> 'rosterViewMinRole') = 'number'
                     THEN j ->> 'rosterViewMinRole' END AS roster,
                CASE WHEN jsonb_typeof(j -> 'memberProgressViewMinRole') = 'number'
                     THEN j ->> 'memberProgressViewMinRole' END AS progress
           FROM s${onlyWithOwnValues ? "\n          WHERE j IS NOT NULL" : ""}`
}

interface OverrideRow { project_id: string; roster: string | null; progress: string | null }

function overridesFromRow(row: OverrideRow): ProjectVisibilityOverrides {
  return {
    rosterViewMinRole: parseProjectVisibilityFloor(row.roster == null ? null : Number(row.roster)),
    memberProgressViewMinRole: parseProjectVisibilityFloor(row.progress == null ? null : Number(row.progress)),
  }
}

/**
 * Each project's own values, for every id asked about (a project with no
 * settings row, or none of its own, maps to nulls). Looked up by primary key.
 */
export async function loadProjectVisibilityOverrides(
  db: AquillaDb,
  projectIds: readonly string[],
): Promise<Map<string, ProjectVisibilityOverrides>> {
  const ids = [...new Set(projectIds)]
  const out = new Map<string, ProjectVisibilityOverrides>(ids.map((id) => [id, NO_OVERRIDES]))
  if (ids.length === 0) return out
  const { results } = await db
    .prepare(
      overridesSql(`FROM project_settings ps
            WHERE ps.project_id IN (${ids.map(() => "?").join(", ")})`),
    )
    .bind(...ids)
    .all<OverrideRow>()
  for (const row of results ?? []) {
    out.set(row.project_id, overridesFromRow(row))
  }
  return out
}

/**
 * The own values of every live (unarchived) project in an org that sets any —
 * for the org's "N projects are stricter" line. Projects that follow the org
 * on both are left out. Starts from the org's projects (idx_projects_org), so
 * only this org's settings rows are ever opened.
 */
export async function loadOrgProjectVisibilityOverrides(
  db: AquillaDb,
  orgId: number,
): Promise<Map<string, ProjectVisibilityOverrides>> {
  const { results } = await db
    .prepare(
      overridesSql(
        `FROM projects p
             JOIN project_settings ps ON ps.project_id = p.id
            WHERE p.org_id = ? AND p.archived_at IS NULL`,
        true,
      ),
    )
    .bind(orgId)
    .all<OverrideRow>()
  return new Map((results ?? []).map((row) => [row.project_id, overridesFromRow(row)]))
}

/** One project's own values. */
export async function loadProjectVisibilityOverride(
  db: AquillaDb,
  projectId: string,
): Promise<ProjectVisibilityOverrides> {
  return (await loadProjectVisibilityOverrides(db, [projectId])).get(projectId) ?? NO_OVERRIDES
}

/**
 * The org's two floors for a project, defaults applied, or null when the
 * project has no org. Reads only these two keys out of the org's blob.
 */
export async function loadOrgVisibilityFloorsForProject(
  db: AquillaDb,
  projectId: string,
): Promise<Record<VisibilityFloorKey, number> | null> {
  const row = await db
    .prepare(
      `SELECT p.org_id AS org_id,
              CASE WHEN jsonb_typeof(x.j -> 'rosterViewMinRole') = 'number'
                   THEN x.j ->> 'rosterViewMinRole' END AS roster,
              CASE WHEN jsonb_typeof(x.j -> 'memberProgressViewMinRole') = 'number'
                   THEN x.j ->> 'memberProgressViewMinRole' END AS progress
         FROM projects p
         LEFT JOIN org_settings os ON os.org_id = p.org_id
         LEFT JOIN LATERAL (SELECT os.settings::jsonb AS j) x ON TRUE
        WHERE p.id = ?`,
    )
    .bind(projectId)
    .first<{ org_id: number | string | null; roster: string | null; progress: string | null }>()
  if (row?.org_id == null) return null
  return {
    rosterViewMinRole: orgVisibilityFloor(
      { rosterViewMinRole: row.roster == null ? null : Number(row.roster) }, "rosterViewMinRole",
    ),
    memberProgressViewMinRole: orgVisibilityFloor(
      { memberProgressViewMinRole: row.progress == null ? null : Number(row.progress) }, "memberProgressViewMinRole",
    ),
  }
}
