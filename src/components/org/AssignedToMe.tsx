import { useEffect, useMemo, useState } from "react"
import { type ColumnDef } from "@tanstack/react-table"
import { useNavigate } from "react-router-dom"
import { Building2 } from "lucide-react"
import { AppShell } from "@/components/AppShell"
import { ADMIN_TABLE_PANEL_CLASS } from "@/components/admin/shared"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { DataTable, DataTableColumnHeader } from "@/components/ui/data-table"
import { missingLast, SORT_MISSING_LAST } from "@/components/ui/data-table-missing"
import { DateTooltip } from "@/components/ui/date-tooltip"
import { EmptyState, Page, PageHeader } from "@/components/ui/page"
import { OrgSidebar } from "./OrgSidebar"
import { OrgBreadcrumb } from "./OrgBreadcrumb"
import { useActiveOrg } from "@/context/OrgContext"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { NAV_PAGE_ICONS } from "@/lib/navigation/page-icons"
import { getMyAssignmentsForOrg, type MyOrgAssignment } from "@/lib/sync/assignments"

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
 * The assignee's "Assigned to me" inbox — the caller's open assignments across
 * the active org, fetched in ONE request (GET /orgs/:orgId/assignments/mine).
 * Previously this fanned out one request per project (N requests, N DB
 * connections); the server now returns all of them in a single query.
 *
 * Layout matches TeamsList: PageHeader + searchable dense DataTable in the
 * shared admin table panel chrome.
 */
export function AssignedToMe() {
  const { activeOrgId } = useActiveOrg()
  const { session } = useFrontierSession()
  const jwt = session?.jwt ?? null
  const navigate = useNavigate()

  const [rows, setRows] = useState<MyOrgAssignment[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!jwt || activeOrgId == null) {
      setRows([])
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    void (async () => {
      try {
        const all = await getMyAssignmentsForOrg(jwt, activeOrgId)
        if (cancelled) return
        // Pair rows + loading so org-assigned-table never mounts empty while
        // the fetch result is already in hand (avoids a race with content asserts).
        setRows(all)
        setLoading(false)
      } catch (e) {
        if (cancelled) return
        setError(e instanceof Error ? e.message : String(e))
        setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [jwt, activeOrgId])

  const columns = useMemo<ColumnDef<MyOrgAssignment>[]>(
    () => [
      {
        id: "assignment",
        accessorFn: (a) => a.scopeLabel.toLowerCase(),
        header: ({ column }) => <DataTableColumnHeader column={column} title="Assignment" />,
        meta: { className: "min-w-0 w-[42%]" },
        cell: ({ row }) => {
          const a = row.original
          return (
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate">{a.scopeLabel}</span>
              {/* AQU-538 (§3.5): lane chip when the assignment is pinned to a lane. */}
              {a.targetLang ? (
                <Badge variant="outline" className="shrink-0">{a.targetLang}</Badge>
              ) : null}
            </div>
          )
        },
      },
      {
        id: "file",
        accessorFn: (a) => missingLast((a.fileName ?? "").toLowerCase()),
        sortUndefined: SORT_MISSING_LAST,
        header: ({ column }) => <DataTableColumnHeader column={column} title="File" />,
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
        header: ({ column }) => <DataTableColumnHeader column={column} title="Project" />,
        meta: { className: "w-[8rem]" },
        cell: ({ row }) => (
          <div className="truncate text-muted-foreground">{row.original.projectName}</div>
        ),
      },
      {
        id: "progress",
        accessorFn: (a) => (a.cellsTotal > 0 ? a.cellsDone / a.cellsTotal : 0),
        header: ({ column }) => (
          <DataTableColumnHeader column={column} title="Progress" className="justify-end" />
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
                {a.cellsDone}/{a.cellsTotal} cells · {pct}%
              </span>
            </div>
          )
        },
      },
      {
        id: "deadline",
        accessorFn: (a) => missingLast(a.deadline),
        sortUndefined: SORT_MISSING_LAST,
        header: ({ column }) => <DataTableColumnHeader column={column} title="Due" />,
        meta: { className: "w-[7rem]" },
        cell: ({ row }) => (
          <DateTooltip
            value={row.original.deadline}
            label="Due"
            className="text-muted-foreground"
          />
        ),
      },
    ],
    [],
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
            title="Assigned to me"
            description="Open work assigned to you across this organization's projects."
            inset={false}
          />

          {activeOrgId == null ? (
            <EmptyState
              icon={Building2}
              title="Select an organization"
              description="Assignments are scoped to a single organization."
            />
          ) : loading ? (
            <div className="h-48 animate-pulse rounded-lg border bg-card" />
          ) : error ? (
            <p className="text-sm text-destructive">{error}</p>
          ) : (
            <DataTable
              columns={columns}
              data={rows}
              getRowId={(a) => a.assignmentId}
              onRowClick={(a) => {
                navigate(assignmentHref(a))
              }}
              initialSorting={[{ id: "deadline", desc: false }]}
              searchPlaceholder="Search assignments…"
              globalFilterFn={(row, _columnId, filterValue) => {
                const q = String(filterValue).trim().toLowerCase()
                if (!q) return true
                const a = row.original
                return (
                  a.scopeLabel.toLowerCase().includes(q) ||
                  a.projectName.toLowerCase().includes(q) ||
                  (a.fileName ? a.fileName.toLowerCase().includes(q) : false) ||
                  (a.targetLang ? a.targetLang.toLowerCase().includes(q) : false)
                )
              }}
              emptyState={(table) => {
                const search = String(table.getState().globalFilter ?? "").trim()
                if (rows.length === 0) {
                  return (
                    <EmptyState
                      variant="inline"
                      className="flex-none py-12"
                      icon={NAV_PAGE_ICONS.assigned}
                      title="You have no open assignments."
                      description="When a manager assigns you a book or chapter, it will show up here."
                    />
                  )
                }
                if (!search) {
                  return (
                    <EmptyState
                      variant="inline"
                      className="flex-none py-12"
                      icon={NAV_PAGE_ICONS.assigned}
                      title="No assignments match your filters"
                    />
                  )
                }
                return (
                  <div className="flex flex-col items-center gap-3 py-10">
                    <p className="text-center text-sm text-muted-foreground">
                      No assignments match your search.
                    </p>
                    <Button
                      variant="outline"
                      onClick={() => table.setGlobalFilter("")}
                    >
                      Clear
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
