import { Button } from "@/components/ui/button"
import type { AdminBillingSort, AdminBillingTierFilter } from "@/lib/frontier/admin"
import { PAGE_SIZE, type RowSaveStatus } from "./useAdminBillingOrgList"

const SELECT_CLASS = "h-8 rounded-md border bg-background px-2 text-xs text-foreground"

/** Plan filter, sort, position and paging for the admin billing org list. */
export function AdminBillingOrgToolbar({
  tierFilter,
  onTierFilter,
  sort,
  onSort,
  offset,
  total,
  loading,
  onOffset,
}: {
  tierFilter: AdminBillingTierFilter | ""
  onTierFilter: (tier: AdminBillingTierFilter | "") => void
  sort: AdminBillingSort
  onSort: (sort: AdminBillingSort) => void
  offset: number
  total: number
  loading: boolean
  onOffset: (offset: number) => void
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <select
        aria-label="Filter by plan"
        data-testid="admin-billing-tier-filter"
        className={SELECT_CLASS}
        value={tierFilter}
        onChange={(e) => onTierFilter(e.target.value as AdminBillingTierFilter | "")}
      >
        <option value="">All plans</option>
        <option value="paid">Paid (Team + Enterprise)</option>
        <option value="enterprise">Enterprise</option>
        <option value="team">Team</option>
        <option value="free">Free</option>
      </select>
      <select
        aria-label="Sort organizations"
        data-testid="admin-billing-sort"
        className={SELECT_CLASS}
        value={sort}
        onChange={(e) => onSort(e.target.value as AdminBillingSort)}
      >
        <option value="name">Name A–Z</option>
        <option value="usage">Most used this period</option>
      </select>
      <span className="tabular-nums" data-testid="admin-billing-org-count">
        {total === 0 ? "0 orgs" : `${offset + 1}–${Math.min(offset + PAGE_SIZE, total)} of ${total}`}
      </span>
      <Button
        size="sm"
        variant="outline"
        disabled={offset === 0 || loading}
        onClick={() => onOffset(Math.max(0, offset - PAGE_SIZE))}
      >
        Previous
      </Button>
      <Button
        size="sm"
        variant="outline"
        disabled={offset + PAGE_SIZE >= total || loading}
        onClick={() => onOffset(offset + PAGE_SIZE)}
        data-testid="admin-billing-next-page"
      >
        Next
      </Button>
    </div>
  )
}

/** Saving / saved / failed for one org's row, under its name. */
export function RowSaveStatusLine({ orgId, status }: { orgId: number; status: RowSaveStatus | undefined }) {
  if (!status) return null
  const testId = `row-status-${orgId}`
  if (status.state === "error") {
    return (
      <p role="alert" data-testid={testId} className="pl-7 text-[10px] text-destructive">
        Not saved: {status.message}
      </p>
    )
  }
  return (
    <p role="status" data-testid={testId} className="pl-7 text-[10px] text-muted-foreground">
      {status.state === "saving" ? "Saving…" : "Saved"}
    </p>
  )
}
