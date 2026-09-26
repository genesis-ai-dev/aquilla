import { useEffect, useMemo, useState } from "react"
import { type ColumnDef } from "@tanstack/react-table"
import { useNavigate } from "react-router-dom"
import { Building2 } from "lucide-react"
import { AppShell } from "@/components/AppShell"
import { ADMIN_TABLE_PANEL_CLASS } from "@/components/admin/shared"
import { AssignmentLaneBadge } from "@/components/AssignmentLaneBadge"
import { Button } from "@/components/ui/button"
import { DataTable, DataTableColumnHeader } from "@/components/ui/data-table"
import { missingLast, SORT_MISSING_LAST } from "@/components/ui/data-table-missing"
import { DateTooltip } from "@/components/ui/date-tooltip"
import { EmptyState, Page, PageHeader, TableEmptyState } from "@/components/ui/page"
import { OrgSidebar } from "./OrgSidebar"
import { OrgBreadcrumb } from "./OrgBreadcrumb"
import { laneChipLabel } from "./project-lanes"
import { useActiveOrg } from "@/context/OrgContext"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { getPortfolio } from "@/lib/frontier/portfolio"
import { NAV_PAGE_ICONS } from "@/lib/navigation/page-icons"
import { getMyAssignmentsForOrg, type MyOrgAssignment } from "@/lib/sync/assignments"
import { useI18n } from "@/lib/i18n/I18nProvider"

function assignmentHref(a: MyOrgAssignment): string {
  const base = a.fileId
    ? `/project/${a.projectId}/editor/file/${encodeURIComponent(a.fileId)}`
    : `/project/${a.projectId}/editor`
  return a.targetLang
    ? `${base}?lane=${encodeURIComponent(a.targetLang)}`
    : base
}

function progressPct(a: MyOrgAssignment): number {
  return a.cellsTotal > 0 ? Math.round((a.cellsDone / a.cellsTotal) * 100) : 0
}

/**
 * One settled answer for one `(jwt, orgId)` request (AQU-1251). Carrying the
 * request identity on the result is what lets the component decide whether it
 * is still loading by looking at state it already has, instead of trusting a
 * separate `loading` flag to have been updated by the right effect run.
 */
interface InboxResult {
  jwt: string
  orgId: number
  rows: MyOrgAssignment[]
  laneLabels: Map<string, string>
  error: string | null
}

/** Stable empties — identity feeds `useMemo` deps, so fresh ones would churn. */
const NO_ROWS: MyOrgAssignment[] = []
const NO_LANE_LABELS: Map<string, string> = new Map()

/**
 * The assignee's "Assigned to me" inbox — the caller's open assignments across
 * the active org, fetched in ONE request (GET /orgs/:orgId/assignments/mine).
 * Previously this fanned out one request per project (N requests, N DB
 * connections); the server now returns all of them in a single query.
 *
 * Layout matches TeamsList: PageHeader + searchable dense DataTable in the
 * shared admin table panel chrome.
 */
export function AssignedToMe() {
  const { t } = useI18n()
  const { activeOrgId } = useActiveOrg()
  const { session } = useFrontierSession()
  const jwt = session?.jwt ?? null
  const navigate = useNavigate()

  // AQU-1251: rows, error and "am I loading" are ONE value keyed to the request
  // that produced it, derived during render — never three `useState`s an effect
  // has to keep in step.
  //
  // They used to be separate, with `loading` flipped inside the fetch effect.
  // That left a render where the table was already on screen but the effect for
  // the current org had not run yet, so a stale `loading === false` painted an
  // authoritative "You have no open assignments." before the skeleton appeared.
  // `activeOrgId` is null during startup while the org directory resolves, and
  // that null took the early-return branch below and set `loading` false — so
  // the flash happened on a normal page load, not just under test. It also made
  // the skeleton assertion in AssignedToMe.test.tsx order-dependent: whether the
  // bad render was still on screen when the assertion ran came down to how
  // quickly React flushed the effect, which is exactly the machine-speed
  // dependency AGENTS.md rule 15 forbids.
  //
  // Keying the result to `(jwt, orgId)` closes the window by construction: a
  // result for a different org cannot satisfy the current request, so `loading`
  // stays true until the answer for THIS org is in hand.
  const [result, setResult] = useState<InboxResult | null>(null)
  const laneFallbackLabel = t("org.projectOverview.laneDefaultFallback")

  const settled =
    result && result.jwt === jwt && result.orgId === activeOrgId ? result : null
  const loading = jwt != null && activeOrgId != null && settled == null
  const rows = settled?.rows ?? NO_ROWS
  const error = settled?.error ?? null
  const defaultLaneLabelByProjectId = settled?.laneLabels ?? NO_LANE_LABELS

  useEffect(() => {
    if (!jwt || activeOrgId == null) return
    let cancelled = false
    void (async () => {
      try {
        const [all, portfolio] = await Promise.all([
          getMyAssignmentsForOrg(jwt, activeOrgId),
          getPortfolio(jwt, activeOrgId),
        ])
        if (cancelled) return
        const laneLabels = new Map(
          portfolio.map((p) => [p.id, p.targetLanguage?.trim() ?? ""]),
        )
        setResult({ jwt, orgId: activeOrgId, rows: all, laneLabels, error: null })
      } catch (e) {
        if (cancelled) return
        setResult({
          jwt,
          orgId: activeOrgId,
          rows: NO_ROWS,
          laneLabels: NO_LANE_LABELS,
          error: e instanceof Error ? e.message : String(e),
        })
      }
    })()
    return () => { cancelled = true }
  }, [jwt, activeOrgId])

  const columns = useMemo<ColumnDef<MyOrgAssignment>[]>(
    () => [
      {
        id: "assignment",
        accessorFn: (a) => a.scopeLabel.toLowerCase(),
        header: ({ column }) => (
          <DataTableColumnHeader column={column} title={t("org.assignedToMe.assignmentColumnLabel")} />
        ),
        meta: { className: "min-w-0 w-[42%]" },
        cell: ({ row }) => {
          const a = row.original
          return (
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate">{a.scopeLabel}</span>
              <AssignmentLaneBadge
                targetLang={a.targetLang}
                defaultLaneLabel={defaultLaneLabelByProjectId.get(a.projectId) ?? ""}
                fallbackLabel={laneFallbackLabel}
              />
            </div>
          )
        },
      },
      {
        id: "file",
        accessorFn: (a) => missingLast((a.fileName ?? "").toLowerCase()),
        sortUndefined: SORT_MISSING_LAST,
        header: ({ column }) => <DataTableColumnHeader column={column} title={t("common.file")} />,
        meta: { className: "min-w-0 w-[28%]" },
        cell: ({ row }) => {
          const name = row.original.fileName
          if (!name) {
            return <span className="text-muted-foreground">—</span>
          }
          return <div className="truncate text-muted-foreground">{name}</div>
        },
      },
      {
        id: "project",
        accessorFn: (a) => a.projectName.toLowerCase(),
        header: ({ column }) => <DataTableColumnHeader column={column} title={t("common.project")} />,
        meta: { className: "w-[8rem]" },
        cell: ({ row }) => (
          <div className="truncate text-muted-foreground">{row.original.projectName}</div>
        ),
      },
      {
        id: "progress",
        accessorFn: (a) => (a.cellsTotal > 0 ? a.cellsDone / a.cellsTotal : 0),
        header: ({ column }) => (
          <DataTableColumnHeader column={column} title={t("fileDetails.progress")} className="justify-end" />
        ),
        meta: { className: "w-[11rem]" },
        cell: ({ row }) => {
          const a = row.original
          const pct = progressPct(a)
          return (
            <div className="flex flex-col items-end gap-1">
              <div className="h-1.5 w-full max-w-[7.5rem] overflow-hidden rounded-full bg-muted">
                <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
              </div>
              <span className="text-xs tabular-nums text-muted-foreground">
                {t("org.assignedToMe.cellsProgress", { done: a.cellsDone, total: a.cellsTotal, pct })}
              </span>
            </div>
          )
        },
      },
      {
        id: "deadline",
        accessorFn: (a) => missingLast(a.deadline),
        sortUndefined: SORT_MISSING_LAST,
        header: ({ column }) => (
          <DataTableColumnHeader column={column} title={t("org.assignedToMe.dueColumnLabel")} />
        ),
        meta: { className: "w-[7rem]" },
        cell: ({ row }) => (
          <DateTooltip
            value={row.original.deadline}
            label={t("org.assignedToMe.dueColumnLabel")}
            variant="deadline"
            className="text-muted-foreground"
          />
        ),
      },
    ],
    [t, defaultLaneLabelByProjectId, laneFallbackLabel],
  )

  return (
    <AppShell
      sidebar={<OrgSidebar />}
      header={<OrgBreadcrumb section="Assigned to me" />}
      statusBar={null}
      main={
        // Match Members / Teams: Page size="wide" (max-w-6xl) inside AppShell.
        // data-testid kept on the Page scroll root for the existing scroll helper.
        <Page size="wide" data-testid="assigned-to-me-scroll" className="overscroll-contain">
          <PageHeader
            title={t("editor.navTitle.assignedToMe")}
            description={t("org.assignedToMe.pageDescription")}
            inset={false}
          />

          {activeOrgId == null ? (
            <EmptyState
              icon={Building2}
              title={t("org.teamsList.selectOrgTitle")}
              description={t("org.assignedToMe.selectOrgDescription")}
            />
          ) : error ? (
            <p className="text-sm text-destructive">{error}</p>
          ) : (
            <DataTable
              columns={columns}
              data={rows}
              loading={loading}
              loadingLabel={t("org.assignedToMe.loadingLabel")}
              getRowId={(a) => a.assignmentId}
              onRowClick={(a) => {
                navigate(assignmentHref(a))
              }}
              rowLink={{ columnId: "assignment", to: assignmentHref }}
              initialSorting={[{ id: "deadline", desc: false }]}
              searchPlaceholder="Search assignments…"
              globalFilterFn={(row, _columnId, filterValue) => {
                const q = String(filterValue).trim().toLowerCase()
                if (!q) return true
                const a = row.original
                const laneLabel = laneChipLabel(
                  a.targetLang ?? "",
                  defaultLaneLabelByProjectId.get(a.projectId) ?? "",
                  laneFallbackLabel,
                )
                return (
                  a.scopeLabel.toLowerCase().includes(q) ||
                  a.projectName.toLowerCase().includes(q) ||
                  (a.fileName ? a.fileName.toLowerCase().includes(q) : false) ||
                  laneLabel.toLowerCase().includes(q)
                )
              }}
              emptyState={(table) => {
                const search = String(table.getState().globalFilter ?? "").trim()
                if (rows.length === 0) {
                  return (
                    <TableEmptyState
                      icon={NAV_PAGE_ICONS.assigned}
                      title={t("org.assignedToMe.emptyTitle")}
                      description={t("org.assignedToMe.noOpenAssignmentsDescription")}
                    />
                  )
                }
                if (!search) {
                  return (
                    <TableEmptyState
                      icon={NAV_PAGE_ICONS.assigned}
                      title={t("org.assignedToMe.noAssignmentsMatchFilters")}
                    />
                  )
                }
                return (
                  <div className="flex flex-col items-center gap-3 py-10">
                    <p className="text-center text-sm text-muted-foreground">
                      {t("org.assignedToMe.noAssignmentsMatchSearch")}
                    </p>
                    <Button
                      variant="outline"
                      onClick={() => table.setGlobalFilter("")}
                    >
                      {t("common.clear")}
                    </Button>
                  </div>
                )
              }}
              testId="org-assigned-table"
              className={ADMIN_TABLE_PANEL_CLASS}
              dense
            />
          )}
        </Page>
      }
    />
  )
}
