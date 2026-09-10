/**
 * AQU-1040 — designated-PM filter for the org Projects portfolio toolbar.
 *
 * Kept as pure derivation + predicate so the option list (which must contain
 * exactly the PMs present in the loaded rows — no stale or invented entries)
 * and the AND-composition with the status filter are unit-testable without
 * rendering the table.
 *
 * The search box keeps its AQU-507 substring behavior, which also matches
 * project/org names and cannot express "no PM"; this control is exact-match.
 */

import type { PortfolioProject } from "@/lib/frontier/portfolio"

export const PM_FILTER_ALL = "all"
export const PM_FILTER_UNASSIGNED = "unassigned"
/**
 * AQU-1027 — identity-relative: "whoever is signed in", not a named PM. Kept
 * as its own sentinel rather than `pm:<viewer>` so the selection survives the
 * viewer being reassigned away (see `resolvePmFilter`).
 */
export const PM_FILTER_MINE = "mine"

/**
 * `pm:<username>` rather than the bare username, so a PM literally named
 * "all", "unassigned" or "mine" cannot collide with the three sentinels.
 */
export type PmFilter =
  | typeof PM_FILTER_ALL
  | typeof PM_FILTER_UNASSIGNED
  | typeof PM_FILTER_MINE
  | `pm:${string}`

const PM_PREFIX = "pm:"

/** Select value that narrows the table to `username`'s projects. */
export function pmFilterFor(username: string): PmFilter {
  return `${PM_PREFIX}${username}`
}

/** The rows this module reads — only the designated PM matters. */
type WithPm = Pick<PortfolioProject, "pm">

function usernameOf(project: WithPm): string | null {
  return project.pm?.username || null
}

function selectedUsername(filter: PmFilter): string {
  return filter.slice(PM_PREFIX.length).toLowerCase()
}

function normalized(username: string | null | undefined): string | null {
  return username?.trim().toLowerCase() || null
}

/**
 * AQU-1027 — whether `viewerUsername` is the designated PM of `project`.
 *
 * The single source of truth for both the "Managed by me" option and the
 * PM column's "(you)" marker, so the two surfaces cannot disagree about
 * identity. `FrontierSession` carries no user id (the JWT `sub` is the
 * username), so this is a case-insensitive username compare, not an id
 * compare — see `callerUserId` in ProjectMembersPage.
 */
export function isManagedBy(
  project: WithPm,
  viewerUsername: string | null | undefined,
): boolean {
  const me = normalized(viewerUsername)
  return me != null && usernameOf(project)?.toLowerCase() === me
}

/**
 * Distinct PM usernames present in `projects`, ordered case-insensitively.
 * Two rows whose PM differs only in case collapse to the first spelling seen,
 * so the option list never shows the same person twice.
 *
 * AQU-1027: `excludeUsername` (the viewer) is dropped, because the pinned
 * "Managed by me" option already covers them — listing them again by name
 * would break the same-person-twice rule above.
 */
export function pmFilterUsernames(
  projects: readonly WithPm[],
  excludeUsername?: string | null,
): string[] {
  const skip = normalized(excludeUsername)
  const byLower = new Map<string, string>()
  for (const project of projects) {
    const username = usernameOf(project)
    if (!username) continue
    const key = username.toLowerCase()
    if (key === skip) continue
    if (!byLower.has(key)) byLower.set(key, username)
  }
  return [...byLower.values()].sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base" }),
  )
}

/** True when at least one loaded row would answer the Unassigned option. */
export function hasUnassignedPm(projects: readonly WithPm[]): boolean {
  return projects.some((project) => usernameOf(project) == null)
}

/**
 * The selection, coerced back to "all" once the PM it names is no longer in
 * the loaded rows (portfolio refresh, PM reassigned elsewhere) — otherwise the
 * table would sit empty against an option the control no longer offers.
 */
export function resolvePmFilter(
  filter: PmFilter,
  usernames: readonly string[],
  hasUnassigned: boolean,
  viewerUsername?: string | null,
): PmFilter {
  if (filter === PM_FILTER_ALL) return PM_FILTER_ALL
  if (filter === PM_FILTER_UNASSIGNED) return hasUnassigned ? filter : PM_FILTER_ALL
  // AQU-1027: deliberately NOT checked against `usernames`. A viewer who
  // manages nothing must get an honest empty table, not a silent widening
  // back to every project in the org. Only a missing viewer clears it.
  if (filter === PM_FILTER_MINE) {
    return normalized(viewerUsername) != null ? PM_FILTER_MINE : PM_FILTER_ALL
  }
  const selected = selectedUsername(filter)
  // The viewer is absent from `usernames` by design (see pmFilterUsernames),
  // so a stale `pm:<viewer>` becomes the identity option rather than "all".
  if (selected === normalized(viewerUsername)) return PM_FILTER_MINE
  return usernames.some((username) => username.toLowerCase() === selected)
    ? filter
    : PM_FILTER_ALL
}

/**
 * Narrow `projects` to the selected PM. Applied to the status-filtered list and
 * ahead of the table's own search, so all three compose with AND semantics.
 */
export function filterByPm<T extends WithPm>(
  projects: readonly T[],
  filter: PmFilter,
  viewerUsername?: string | null,
): T[] {
  if (filter === PM_FILTER_ALL) return [...projects]
  if (filter === PM_FILTER_UNASSIGNED) {
    return projects.filter((project) => usernameOf(project) == null)
  }
  // A signed-out viewer matches nothing rather than everything — the control
  // omits the option in that case, so this is belt-and-braces.
  if (filter === PM_FILTER_MINE) {
    return projects.filter((project) => isManagedBy(project, viewerUsername))
  }
  const selected = selectedUsername(filter)
  return projects.filter((project) => usernameOf(project)?.toLowerCase() === selected)
}
