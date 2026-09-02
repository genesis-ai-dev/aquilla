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
 * `pm:<username>` rather than the bare username, so a PM literally named
 * "all" or "unassigned" cannot collide with the two sentinels.
 */
export type PmFilter = typeof PM_FILTER_ALL | typeof PM_FILTER_UNASSIGNED | `pm:${string}`

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

/**
 * Distinct PM usernames present in `projects`, ordered case-insensitively.
 * Two rows whose PM differs only in case collapse to the first spelling seen,
 * so the option list never shows the same person twice.
 */
export function pmFilterUsernames(projects: readonly WithPm[]): string[] {
  const byLower = new Map<string, string>()
  for (const project of projects) {
    const username = usernameOf(project)
    if (!username) continue
    const key = username.toLowerCase()
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
): PmFilter {
  if (filter === PM_FILTER_ALL) return PM_FILTER_ALL
  if (filter === PM_FILTER_UNASSIGNED) return hasUnassigned ? filter : PM_FILTER_ALL
  const selected = selectedUsername(filter)
  return usernames.some((username) => username.toLowerCase() === selected)
    ? filter
    : PM_FILTER_ALL
}

/**
 * Narrow `projects` to the selected PM. Applied to the status-filtered list and
 * ahead of the table's own search, so all three compose with AND semantics.
 */
export function filterByPm<T extends WithPm>(projects: readonly T[], filter: PmFilter): T[] {
  if (filter === PM_FILTER_ALL) return [...projects]
  if (filter === PM_FILTER_UNASSIGNED) {
    return projects.filter((project) => usernameOf(project) == null)
  }
  const selected = selectedUsername(filter)
  return projects.filter((project) => usernameOf(project)?.toLowerCase() === selected)
}
