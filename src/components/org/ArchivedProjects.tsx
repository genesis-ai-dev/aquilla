import { useCallback, useEffect, useMemo, useState } from "react"
import { type ColumnDef } from "@tanstack/react-table"
import { AppShell } from "@/components/AppShell"
import { OrgSidebar } from "./OrgSidebar"
import { OrgBreadcrumb } from "./OrgBreadcrumb"
import { ADMIN_TABLE_PANEL_CLASS } from "@/components/admin/shared"
import { Button } from "@/components/ui/button"
import { DataTable, DataTableColumnHeader } from "@/components/ui/data-table"
import { missingLast, SORT_MISSING_LAST } from "@/components/ui/data-table-missing"
import { DateTooltip } from "@/components/ui/date-tooltip"
import { Spinner } from "@/components/ui/spinner"
import { Page, PageHeader, EmptyState } from "@/components/ui/page"
import { useActiveOrg } from "@/context/OrgContext"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { fetchArchivedProjects, type CloudProjectSummary } from "@/lib/sync/cloud-projects"
import { unarchiveProjectRemote } from "@/lib/sync/archive"
import { NAV_PAGE_ICONS } from "@/lib/navigation/page-icons"
import { Building2 } from "lucide-react"

export function ArchivedProjects() {
  const { activeOrgId } = useActiveOrg()
  const { session } = useFrontierSession()
  const jwt = session?.jwt ?? null
  const [projects, setProjects] = useState<CloudProjectSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [restoringId, setRestoringId] = useState<string | null>(null)

  const load = useCallback(() => {
    if (!jwt || activeOrgId == null) {
      setProjects([])
      setLoading(false)
      return
    }
    setLoading(true)
    fetchArchivedProjects(jwt, activeOrgId)
      .then(setProjects)
      .finally(() => setLoading(false))
  }, [jwt, activeOrgId])

  useEffect(() => {
    load()
  }, [load])

  const handleRestore = useCallback(
    async (id: string) => {
      if (!jwt || restoringId) return
      setError(null)
      setRestoringId(id)
      try {
        const res = await unarchiveProjectRemote(id, jwt)
        if (res.kind === "restored" || res.kind === "local-only") {
          load()
        } else if (res.kind === "forbidden") {
          setError(res.message ?? "Only owners can restore a project.")
        } else if (res.kind === "error") {
          setError(res.message)
        }
      } finally {
        setRestoringId(null)
      }
    },
    [jwt, load, restoringId],
  )

  const columns = useMemo<ColumnDef<CloudProjectSummary>[]>(
    () => [
      {
        id: "name",
        accessorFn: (p) => p.name.toLowerCase(),
        header: ({ column }) => <DataTableColumnHeader column={column} title="Project" />,
        meta: { className: "min-w-0" },
        cell: ({ row }) => (
          <span className="font-medium text-foreground">{row.original.name}</span>
        ),
      },
      {
        id: "archivedAt",
        accessorFn: (p) => missingLast(p.archivedAt ?? undefined),
        sortUndefined: SORT_MISSING_LAST,
        header: ({ column }) => <DataTableColumnHeader column={column} title="Archived" />,
        meta: { className: "w-[9rem]" },
        cell: ({ row }) => (
          <DateTooltip
            value={row.original.archivedAt}
            label="Archived"
            className="text-muted-foreground"
          />
        ),
      },
      {
        id: "files",
        accessorFn: (p) => p.files?.length ?? 0,
        header: ({ column }) => (
          <DataTableColumnHeader column={column} title="Files" className="justify-end" />
        ),
        meta: { className: "w-[5.5rem]" },
        cell: ({ row }) => (
          <div className="text-right tabular-nums text-muted-foreground">
            {row.original.files?.length ?? 0}
          </div>
        ),
      },
      {
        id: "actions",
        enableSorting: false,
        header: () => <span className="sr-only">Actions</span>,
        meta: { className: "w-[7.5rem]" },
        cell: ({ row }) => {
          const id = row.original.id
          const busy = restoringId === id
          return (
            <div className="flex justify-end">
              <Button
                type="button"
                variant="outline"
                disabled={restoringId != null}
                onClick={(e) => {
                  e.stopPropagation()
                  void handleRestore(id)
                }}
              >
                {busy && <Spinner data-icon="inline-start" />}
                {busy ? "Restoring…" : "Restore"}
              </Button>
            </div>
          )
        },
      },
    ],
    [handleRestore, restoringId],
  )

  return (
    <AppShell
      sidebar={<OrgSidebar />}
      header={<OrgBreadcrumb section="Archived" />}
      statusBar={null}
      main={
        <Page size="wide" data-testid="archived-projects-scroll">
          <PageHeader
            title="Archived"
            description="Projects you've archived. Restore one to bring it back to the active list."
            inset={false}
          />

          {error && (
            <p className="mb-4 text-sm text-destructive" role="alert">
              {error}
            </p>
          )}

          {activeOrgId == null ? (
            <EmptyState
              icon={Building2}
              title="Select an organization"
              description="Archived projects are managed within a single organization."
            />
          ) : loading ? (
            <div
              className="h-48 animate-pulse rounded-lg border bg-card"
              role="status"
              aria-busy="true"
              aria-label="Loading archived projects"
            />
          ) : projects.length === 0 ? (
            <EmptyState
              icon={NAV_PAGE_ICONS.archived}
              title="No archived projects."
              description="When you archive a project, it shows up here until you restore it."
            />
          ) : (
            <DataTable
              columns={columns}
              data={projects}
              getRowId={(p) => p.id}
              initialSorting={[{ id: "archivedAt", desc: true }]}
              searchPlaceholder="Search archived projects…"
              globalFilterFn={(row, _columnId, filterValue) => {
                const q = String(filterValue).trim().toLowerCase()
                if (!q) return true
                return row.original.name.toLowerCase().includes(q)
              }}
              toolbar={(table) => (
                <span className="ml-auto text-xs tabular-nums text-muted-foreground">
                  {table.getFilteredRowModel().rows.length === projects.length
                    ? `${projects.length}`
                    : `${table.getFilteredRowModel().rows.length} of ${projects.length}`}
                </span>
              )}
              emptyState={
                <div className="flex flex-col items-center gap-3 py-10">
                  <p className="text-center text-sm text-muted-foreground">
                    No archived projects match your search.
                  </p>
                </div>
              }
              testId="org-archived-projects-table"
              className={ADMIN_TABLE_PANEL_CLASS}
              dense
            />
          )}
        </Page>
      }
    />
  )
}
