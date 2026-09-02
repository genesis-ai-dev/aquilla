/**
 * AQU-1043 — last-edit recency filter for the org Projects portfolio toolbar.
 *
 * Sibling of `project-pm-filter.ts` (AQU-1040) and `project-role-filter.ts`
 * (AQU-1042): pure derivation + predicate so the AND-composition with the
 * status, PM and Role filters stays unit-testable without rendering the table.
 *
 * Unlike those two, the option list is **not** data-derived — the buckets are
 * fixed windows (last 7 / 30 / 90 days) so the control reads the same on every
 * portfolio, and "any time" is always the default. The value it narrows on is
 * the Updated column's `lastEditAt`; rows with no edit at all (the column's
 * "—") are excluded from every window but still listed under "any time".
 */

import type { PortfolioProject } from "@/lib/frontier/portfolio"

export const UPDATED_FILTER_ANY = "any"

/**
 * `days:<n>` rather than a bare number, mirroring the PM/Role filters'
 * sentinel-proof shape so a window can never collide with the "any" sentinel.
 */
export type UpdatedFilter = typeof UPDATED_FILTER_ANY | `days:${number}`

const DAYS_PREFIX = "days:"

const MS_PER_DAY = 24 * 60 * 60 * 1000

/**
 * The offered windows, in days, shortest first. Fixed rather than free-form
 * dates per the ticket: the control is a recency bucket picker, not a date
 * range picker.
 */
export const UPDATED_FILTER_WINDOW_DAYS = [7, 30, 90] as const

export type UpdatedFilterWindowDays = (typeof UPDATED_FILTER_WINDOW_DAYS)[number]

/** Select value that narrows the table to rows edited within the last `days`. */
export function updatedFilterFor(days: UpdatedFilterWindowDays): UpdatedFilter {
  return `${DAYS_PREFIX}${days}`
}

/** The rows this module reads — only the last-edit stamp matters. */
type WithLastEdit = Pick<PortfolioProject, "lastEditAt">

function selectedDays(filter: UpdatedFilter): number {
  return Number(filter.slice(DAYS_PREFIX.length))
}

/**
 * The selection, coerced back to "any" unless it names one of the offered
 * windows. The buckets are fixed, so this only ever fires on a stale or
 * hand-crafted value — but it keeps the table from sitting empty against an
 * option the control doesn't offer, exactly as the PM and Role filters do.
 */
export function resolveUpdatedFilter(filter: UpdatedFilter): UpdatedFilter {
  if (filter === UPDATED_FILTER_ANY) return UPDATED_FILTER_ANY
  const days = selectedDays(filter)
  return UPDATED_FILTER_WINDOW_DAYS.some((d) => d === days) ? filter : UPDATED_FILTER_ANY
}

/**
 * Narrow `projects` to rows whose last edit falls inside the selected window.
 * Applied after the status, PM and Role filters and ahead of the table's own
 * search, so all five compose with AND semantics.
 *
 * `now` is the portfolio's frozen clock (`useOrgPortfolio().now`), the same one
 * the Updated column renders its relative times from — so the filter and the
 * column can never disagree about how old a row is mid-view.
 *
 * Never-edited rows (`lastEditAt == null`, the column's "—") pass only under
 * "any time". A stamp in the future (clock skew between the server that wrote
 * it and this browser) counts as recent, which is what the column shows too.
 */
export function filterByUpdated<T extends WithLastEdit>(
  projects: readonly T[],
  filter: UpdatedFilter,
  now: number,
): T[] {
  if (filter === UPDATED_FILTER_ANY) return [...projects]
  const windowMs = selectedDays(filter) * MS_PER_DAY
  return projects.filter((project) => {
    const lastEditAt = project.lastEditAt
    if (lastEditAt == null) return false
    return now - lastEditAt <= windowMs
  })
}
