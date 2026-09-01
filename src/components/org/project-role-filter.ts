/**
 * AQU-1042 — viewer-role filter for the org Projects portfolio toolbar.
 *
 * Sibling of `project-pm-filter.ts` (AQU-1040): pure derivation + predicate so
 * the option list (exactly the roles present in the loaded rows — never the
 * full ladder) and the AND-composition with the status and PM filters stay
 * unit-testable without rendering the table.
 *
 * The role in question is the signed-in viewer's role in each project — the
 * value the table's Role column renders from `roleByProjectId`, not a member
 * roster. Rows the map doesn't cover (the column's "—") only ever appear
 * under the "all" default; there is deliberately no "no role" option, per the
 * ticket's AC.
 */

import { roleLevelFromName } from "@/lib/frontier/roles"

export const ROLE_FILTER_ALL = "all"

/**
 * `role:<name>` rather than the bare canonical name, mirroring the PM
 * filter's sentinel-proof shape, so the "all" sentinel can never collide with
 * a role value.
 */
export type RoleFilter = typeof ROLE_FILTER_ALL | `role:${string}`

const ROLE_PREFIX = "role:"

/** Select value that narrows the table to projects where the viewer holds `name`. */
export function roleFilterFor(name: string): RoleFilter {
  return `${ROLE_PREFIX}${name}`
}

/** The slice of `roleByProjectId` values this module reads. */
type RoleEntry = { name: string }

/** Row shape: only the id matters — the role comes from the lookup map. */
type WithId = { id: string }

type RoleLookup = ReadonlyMap<string, RoleEntry | null | undefined> | undefined

function roleNameOf(project: WithId, roleByProjectId: RoleLookup): string | null {
  return roleByProjectId?.get(project.id)?.name || null
}

function selectedName(filter: RoleFilter): string {
  return filter.slice(ROLE_PREFIX.length)
}

/**
 * Distinct canonical role names present in `projects`, in ladder order
 * (viewer → owner). A name outside the canonical ladder (corrupt data, a
 * future server-side role) sorts after the ladder, alphabetically — still
 * offered, since the Role column renders it too.
 */
export function roleFilterNames(
  projects: readonly WithId[],
  roleByProjectId: RoleLookup,
): string[] {
  const present = new Set<string>()
  for (const project of projects) {
    const name = roleNameOf(project, roleByProjectId)
    if (name) present.add(name)
  }
  return [...present].sort((a, b) => {
    const levelA = roleLevelFromName(a)
    const levelB = roleLevelFromName(b)
    if (levelA != null && levelB != null) return levelA - levelB
    if (levelA != null) return -1
    if (levelB != null) return 1
    return a.localeCompare(b)
  })
}

/**
 * The selection, coerced back to "all" once the role it names is no longer in
 * the loaded rows (portfolio refresh, membership change) — otherwise the
 * table would sit empty against an option the control no longer offers.
 */
export function resolveRoleFilter(filter: RoleFilter, names: readonly string[]): RoleFilter {
  if (filter === ROLE_FILTER_ALL) return ROLE_FILTER_ALL
  return names.includes(selectedName(filter)) ? filter : ROLE_FILTER_ALL
}

/**
 * Narrow `projects` to rows where the viewer holds the selected role. Applied
 * after the status and PM filters and ahead of the table's own search, so all
 * four compose with AND semantics. Roleless rows ("—") pass only under "all".
 */
export function filterByRole<T extends WithId>(
  projects: readonly T[],
  roleByProjectId: RoleLookup,
  filter: RoleFilter,
): T[] {
  if (filter === ROLE_FILTER_ALL) return [...projects]
  const selected = selectedName(filter)
  return projects.filter((project) => roleNameOf(project, roleByProjectId) === selected)
}
