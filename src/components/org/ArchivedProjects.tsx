import { useCallback, useEffect, useMemo, useState } from "react"
import { type ColumnDef } from "@tanstack/react-table"
import { useLocation, useNavigate } from "react-router-dom"
import { AppShell } from "@/components/AppShell"
import { OrgSidebar } from "./OrgSidebar"
import { OrgBreadcrumb } from "./OrgBreadcrumb"
import { ADMIN_TABLE_PANEL_CLASS } from "@/components/admin/shared"
import {
  DataTable,
  DataTableColumnHeader,
  DataTableRowActionsButton,
} from "@/components/ui/data-table"
import { missingLast, SORT_MISSING_LAST } from "@/components/ui/data-table-missing"
import { DateTooltip } from "@/components/ui/date-tooltip"
import { MenuItem } from "@/components/ui/menu-parts"
import { Button } from "@/components/ui/button"
import { Page, PageHeader, EmptyState } from "@/components/ui/page"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useActiveOrg } from "@/context/OrgContext"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import {
  fetchArchivedProjects,
  fetchOrgDeletedFiles,
  type CloudProjectSummary,
  type OrgDeletedFile,
} from "@/lib/sync/cloud-projects"
import { unarchiveProjectRemote } from "@/lib/sync/archive"
import { emitFileRestore, InsufficientRoleError } from "@/lib/sync/events-emit"
import { archivedPath } from "@/lib/navigation/org-paths"
import { NAV_PAGE_ICONS } from "@/lib/navigation/page-icons"
import { ArchiveRestore, Building2 } from "lucide-react"

type ArchivedTab = "projects" | "files"

export function ArchivedProjects() {
  const { activeOrgId } = useActiveOrg()
  const { session } = useFrontierSession()
  const jwt = session?.jwt ?? null
  const username = session?.username ?? "unknown"
  const location = useLocation()
  const navigate = useNavigate()
  const tab: ArchivedTab = location.pathname.endsWith("/files") ? "files" : "projects"

  const [projects, setProjects] = useState<CloudProjectSummary[]>([])
  const [projectsLoading, setProjectsLoading] = useState(true)
  const [files, setFiles] = useState<OrgDeletedFile[]>([])
  const [filesLoading, setFilesLoading] = useState(false)
  const [filesLoaded, setFilesLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [restoringId, setRestoringId] = useState<string | null>(null)

  const loadProjects = useCallback(() => {
    if (!jwt || activeOrgId == null) {
      setProjects([])
      setProjectsLoading(false)
      return
    }
    setProjectsLoading(true)
    fetchArchivedProjects(jwt, activeOrgId)
      .then(setProjects)
      .finally(() => setProjectsLoading(false))
  }, [jwt, activeOrgId])

  const loadFiles = useCallback(() => {
    if (!jwt || activeOrgId == null) {
      setFiles([])
      setFilesLoading(false)
      setFilesLoaded(true)
      return
    }
    setFilesLoading(true)
    fetchOrgDeletedFiles(jwt, activeOrgId)
      .then(setFiles)
      .finally(() => {
        setFilesLoading(false)
        setFilesLoaded(true)
      })
  }, [jwt, activeOrgId])

  useEffect(() => {
    loadProjects()
  }, [loadProjects])

  useEffect(() => {
    setFiles([])
    setFilesLoaded(false)
  }, [jwt, activeOrgId])

  useEffect(() => {
    if (tab === "files" && !filesLoaded) loadFiles()
  }, [tab, filesLoaded, loadFiles])

  function setTab(next: ArchivedTab) {
    if (activeOrgId == null) return
    navigate(archivedPath(activeOrgId, next), { replace: true })
  }

  const handleRestoreProject = useCallback(
    async (id: string) => {
      if (!jwt || restoringId) return
      setError(null)
      setRestoringId(id)
      try {
        const res = await unarchiveProjectRemote(id, jwt)
        if (res.kind === "restored" || res.kind === "local-only") {
          loadProjects()
        } else if (res.kind === "forbidden") {
          setError(res.message ?? "Only owners can restore a project.")
        } else if (res.kind === "error") {
          setError(res.message)
        }
      } finally {
        setRestoringId(null)
      }
    },
    [jwt, loadProjects, restoringId],
  )

  const handleRestoreFile = useCallback(
    async (file: OrgDeletedFile) => {
      if (restoringId) return
      setError(null)
      setRestoringId(file.fileId)
      try {
        await emitFileRestore({
          projectId: file.projectId,
          fileId: file.fileId,
          author: username,
        })
        setFiles((current) => current.filter((f) => f.fileId !== file.fileId))
      } catch (e) {
        if (e instanceof InsufficientRoleError) {
          setError("Only project leads and above can restore a file.")
        } else {
          setError(e instanceof Error ? e.message : "Couldn't restore that file.")
        }
      } finally {
        setRestoringId(null)
      }
    },
    [restoringId, username],
  )

  const projectColumns = useMemo<ColumnDef<CloudProjectSummary>[]>(
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
        meta: { className: "w-10" },
        cell: ({ row }) => {
          const p = row.original
          return (
            <DataTableRowActionsButton
              label={`More actions for ${p.name}`}
              data-testid={`archived-row-actions-${p.id}`}
              revealOnHover
              disabled={restoringId != null}
              busy={restoringId === p.id}
            />
          )
        },
      },
    ],
    [restoringId],
  )

  const fileColumns = useMemo<ColumnDef<OrgDeletedFile>[]>(
    () => [
      {
        id: "name",
        accessorFn: (f) => f.name.toLowerCase(),
        header: ({ column }) => <DataTableColumnHeader column={column} title="File" />,
        meta: { className: "min-w-0" },
        cell: ({ row }) => (
          <span className="font-medium text-foreground">{row.original.name}</span>
        ),
      },
      {
        id: "project",
        accessorFn: (f) => f.projectName.toLowerCase(),
        header: ({ column }) => <DataTableColumnHeader column={column} title="Project" />,
        meta: { className: "w-[12rem]" },
        cell: ({ row }) => (
          <span className="text-muted-foreground">{row.original.projectName}</span>
        ),
      },
      {
        id: "deletedAt",
        accessorFn: (f) => missingLast(f.deletedAt),
        sortUndefined: SORT_MISSING_LAST,
        header: ({ column }) => <DataTableColumnHeader column={column} title="Deleted" />,
        meta: { className: "w-[9rem]" },
        cell: ({ row }) => (
          <DateTooltip
            value={row.original.deletedAt}
            label="Deleted"
            className="text-muted-foreground"
          />
        ),
      },
      {
        id: "actions",
        enableSorting: false,
        header: () => <span className="sr-only">Actions</span>,
        meta: { className: "w-10" },
        cell: ({ row }) => {
          const f = row.original
          return (
            <DataTableRowActionsButton
              label={`More actions for ${f.name}`}
              data-testid={`deleted-file-row-actions-${f.fileId}`}
              revealOnHover
              disabled={restoringId != null}
              busy={restoringId === f.fileId}
            />
          )
        },
      },
    ],
    [restoringId],
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
            description={
              tab === "files"
                ? "Files deleted from projects in this organization. Restore one to put it back in its project."
                : "Projects you've archived. Restore one to bring it back to the active list."
            }
            inset={false}
            className="mb-6"
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
          ) : (
            <Tabs
              value={tab}
              onValueChange={(v) => setTab(v as ArchivedTab)}
              className="gap-4"
            >
              <TabsList aria-label="Archived views">
                <TabsTrigger value="projects">Projects</TabsTrigger>
                <TabsTrigger value="files">Recently deleted</TabsTrigger>
              </TabsList>

              <TabsContent value="projects">
                {projectsLoading ? (
                  <div
                    className="h-48 animate-pulse rounded-lg border bg-card"
                    role="status"
                    aria-busy="true"
                    aria-label="Loading archived projects"
                  />
                ) : (
                  <DataTable
                    columns={projectColumns}
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
                    renderRowMenuItems={(p) => (
                      <MenuItem
                        disabled={restoringId != null}
                        onClick={() => void handleRestoreProject(p.id)}
                      >
                        <ArchiveRestore className="size-4" />
                        Restore
                      </MenuItem>
                    )}
                    emptyState={(table) => {
                      if (projects.length === 0) {
                        return (
                          <EmptyState
                            variant="inline"
                            className="flex-none py-12"
                            icon={NAV_PAGE_ICONS.archived}
                            title="No archived projects."
                            description="When you archive a project, it shows up here until you restore it."
                          />
                        )
                      }
                      return (
                        <div className="flex flex-col items-center gap-3 py-10">
                          <p className="text-center text-sm text-muted-foreground">
                            No archived projects match your search.
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
                    testId="org-archived-projects-table"
                    className={ADMIN_TABLE_PANEL_CLASS}
                    dense
                  />
                )}
              </TabsContent>

              <TabsContent value="files">
                {filesLoading || !filesLoaded ? (
                  <div
                    className="h-48 animate-pulse rounded-lg border bg-card"
                    role="status"
                    aria-busy="true"
                    aria-label="Loading recently deleted files"
                  />
                ) : (
                  <DataTable
                    columns={fileColumns}
                    data={files}
                    getRowId={(f) => f.fileId}
                    initialSorting={[{ id: "deletedAt", desc: true }]}
                    searchPlaceholder="Search deleted files…"
                    globalFilterFn={(row, _columnId, filterValue) => {
                      const q = String(filterValue).trim().toLowerCase()
                      if (!q) return true
                      const f = row.original
                      return (
                        f.name.toLowerCase().includes(q) ||
                        f.projectName.toLowerCase().includes(q)
                      )
                    }}
                    toolbar={(table) => (
                      <span className="ml-auto text-xs tabular-nums text-muted-foreground">
                        {table.getFilteredRowModel().rows.length === files.length
                          ? `${files.length}`
                          : `${table.getFilteredRowModel().rows.length} of ${files.length}`}
                      </span>
                    )}
                    renderRowMenuItems={(f) => (
                      <MenuItem
                        disabled={restoringId != null}
                        onClick={() => void handleRestoreFile(f)}
                      >
                        <ArchiveRestore className="size-4" />
                        Restore
                      </MenuItem>
                    )}
                    emptyState={(table) => {
                      if (files.length === 0) {
                        return (
                          <EmptyState
                            variant="inline"
                            className="flex-none py-12"
                            icon={NAV_PAGE_ICONS.file}
                            title="No recently deleted files."
                            description="When you delete a file from a project, it shows up here until you restore it."
                          />
                        )
                      }
                      return (
                        <div className="flex flex-col items-center gap-3 py-10">
                          <p className="text-center text-sm text-muted-foreground">
                            No deleted files match your search.
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
                    testId="org-deleted-files-table"
                    className={ADMIN_TABLE_PANEL_CLASS}
                    dense
                  />
                )}
              </TabsContent>
            </Tabs>
          )}
        </Page>
      }
    />
  )
}
