import { LoadingTemplate } from "@/components/ui/loading-overlay"
import { Skeleton } from "@/components/ui/skeleton"

export { ValidatedBar } from "./ValidatedBar"

/**
 * First-load placeholder for an admin console section (AQU-942).
 *
 * Only for a section that has never resolved its data. Once a section holds
 * rows, a revalidation must keep the real shell mounted — every admin mutation
 * here re-fetches, and swapping back to a placeholder takes the table, its
 * filters and the admin's scroll position with it.
 */
export function AdminSectionSkeleton({ label, blocks = 3 }: { label: string; blocks?: number }) {
  return (
    <LoadingTemplate label={label} className="min-h-[18rem]" templateClassName="min-h-[18rem]">
      <div className="flex flex-col gap-4">
        <Skeleton className="h-6 w-56 rounded-md" />
        {Array.from({ length: blocks }).map((_, i) => (
          <Skeleton key={i} className="h-24 rounded-lg border bg-card" />
        ))}
      </div>
    </LoadingTemplate>
  )
}

/** GitLab full_paths lead with the org's own path; drop it so a team reads locally. */
export function relativeTeamPath(name: string): string {
  const i = name.indexOf("/")
  return i === -1 ? name : name.slice(i + 1)
}

/** Shared row chrome for admin DataTables (no row rules, muted rounded hover). */
const ADMIN_TABLE_ROW_CHROME =
  // Vertical padding matches the first-cell left inset (pl-2) so the hover
  // wash reads as an even inset on all sides of the bled row.
  "[&_tr]:border-b-0! [&_tbody_tr]:hover:bg-transparent! [&_tbody_tr:hover>td]:bg-muted/50 [&_tbody_tr:hover>td:first-child]:rounded-l-lg [&_tbody_tr:hover>td:last-child]:rounded-r-lg [&_th]:py-2! [&_td]:py-2! [&_th:first-child]:pl-2! [&_td:first-child]:pl-2! [&_th:last-child]:pr-2! [&_td:last-child]:pr-2!"

/**
 * In-card admin DataTable chrome — borderless, with -mx-2 bleed so hover sits
 * in the surrounding Section padding while edge cells keep text aligned.
 */
export const ADMIN_TABLE_CLASS =
  `border-0 -mx-2 overflow-visible ${ADMIN_TABLE_ROW_CHROME}`

/**
 * Standalone page-level admin DataTable chrome — rounded card shell around the
 * whole table (People / Projects / Tenants / Teams).
 */
export const ADMIN_TABLE_PANEL_CLASS =
  `rounded-lg! bg-card px-2 py-2 ${ADMIN_TABLE_ROW_CHROME}`

/** Section header/content padding paired with ADMIN_TABLE_CLASS inside cards. */
export const ADMIN_TABLE_SECTION_HEADER = "px-5 pt-5 pb-0"
export const ADMIN_TABLE_SECTION_CONTENT = "px-5 pt-2 pb-3"

// Back-compat re-exports — prefer @/components/ProjectStatus directly.
export {
  LinearStatus,
  ProjectAttentionStatuses as AttentionBadges,
  ProjectStatus as AdminProjectStatus,
} from "@/components/ProjectStatus"
