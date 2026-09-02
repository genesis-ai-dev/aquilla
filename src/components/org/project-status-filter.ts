import type { StatusFilter } from "@/hooks/useOrgPortfolio"
import type { MessageKey } from "@/lib/i18n/messages/en"

/**
 * The status filter's option list — catalog keys, not display strings,
 * resolved with `t()` at render time. Each reuses an identical-text key
 * already established elsewhere (org.orgHome.stalled/overdue/statusFilter.all,
 * org.overview.needsAttentionHeading) rather than minting duplicates for the
 * same words.
 *
 * Sibling of `project-pm-filter.ts` and friends, though options-only: the
 * narrowing itself lives in `useOrgPortfolio().filterByStatus`. Shared by
 * OrgHome's standalone `ProjectStatusFilter` and the org Projects page's
 * combined Sort by menu (`ProjectSortMenu`, AQU-1044) so both always offer
 * exactly the same statuses.
 */
export const STATUS_FILTERS: { value: StatusFilter; labelKey: MessageKey }[] = [
  { value: "all", labelKey: "org.orgHome.statusFilter.all" },
  { value: "stalled", labelKey: "org.orgHome.stalled" },
  { value: "overdue", labelKey: "org.orgHome.overdue" },
  { value: "attention", labelKey: "org.overview.needsAttentionHeading" },
]
