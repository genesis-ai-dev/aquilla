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
import { Page, PageHeader, EmptyState, TableEmptyState } from "@/components/ui/page"
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
import { useI18n } from "@/lib/i18n/I18nProvider"

type ArchivedTab = "projects" | "files"

export function ArchivedProjects() {
  const { t } = useI18n()
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
        header: ({ column }) => <DataTableColumnHeader column={column} title={t("common.project")} />,
        meta: { className: "min-w-0" },
        cell: ({ row }) => (
          <span className="font-medium text-foreground">{row.original.name}</span>
        ),
      },
      {
        id: "archivedAt",
        accessorFn: (p) => missingLast(p.archivedAt ?? undefined),
        sortUndefined: SORT_MISSING_LAST,
        header: ({ column }) => (
          <DataTableColumnHeader column={column} title={t("org.orgSidebar.archived")} />
        ),
        meta: { className: "w-[9rem]" },
        cell: ({ row }) => (
          <DateTooltip
            value={row.original.archivedAt}
            label={t("org.orgSidebar.archived")}
            className="text-muted-foreground"
          />
        ),
      },
      {
        id: "files",
        accessorFn: (p) => p.files?.length ?? 0,
        header: ({ column }) => (
          <DataTableColumnHeader column={column} title={t("nav.dock.filesTab")} className="justify-end" />
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
        header: () => <span className="sr-only">{t("org.overviewLaneTable.actionsColumn")}</span>,
        meta: { className: "w-10" },
        cell: ({ row }) => {
          const p = row.original
          return (
            <DataTableRowActionsButton
              label={t("org.orgProjectsDataTable.moreActionsAriaLabel", { name: p.name })}
              data-testid={`archived-row-actions-${p.id}`}
              revealOnHover
              disabled={restoringId != null}
              busy={restoringId === p.id}
            />
          )
        },
      },
    ],
    [restoringId, t],
  )

  const fileColumns = useMemo<ColumnDef<OrgDeletedFile>[]>(
    () => [
      {
        id: "name",
        accessorFn: (f) => f.name.toLowerCase(),
        header: ({ column }) => <DataTableColumnHeader column={column} title={t("common.file")} />,
        meta: { className: "min-w-0" },
        cell: ({ row }) => (
          <span className="font-medium text-foreground">{row.original.name}</span>
        ),
      },
      {
        id: "project",
        accessorFn: (f) => f.projectName.toLowerCase(),
        header: ({ column }) => <DataTableColumnHeader column={column} title={t("common.project")} />,
        meta: { className: "w-[12rem]" },
        cell: ({ row }) => (
          <span className="text-muted-foreground">{row.original.projectName}</span>
        ),
      },
      {
        id: "deletedAt",
        accessorFn: (f) => missingLast(f.deletedAt),
        sortUndefined: SORT_MISSING_LAST,
        header: ({ column }) => (
          <DataTableColumnHeader column={column} title={t("org.archivedProjects.deletedColumnLabel")} />
        ),
        meta: { className: "w-[9rem]" },
        cell: ({ row }) => (
          <DateTooltip
            value={row.original.deletedAt}
            label={t("org.archivedProjects.deletedColumnLabel")}
            className="text-muted-foreground"
          />
        ),
      },
      {
        id: "actions",
        enableSorting: false,
        header: () => <span className="sr-only">{t("org.overviewLaneTable.actionsColumn")}</span>,
        meta: { className: "w-10" },
        cell: ({ row }) => {
          const f = row.original
          return (
            <DataTableRowActionsButton
              label={t("org.orgProjectsDataTable.moreActionsAriaLabel", { name: f.name })}
              data-testid={`deleted-file-row-actions-${f.fileId}`}
              revealOnHover
              disabled={restoringId != null}
              busy={restoringId === f.fileId}
            />
          )
        },
      },
    ],
    [restoringId, t],
  )

  return (
    <AppShell
      sidebar={<OrgSidebar />}
      header={<OrgBreadcrumb section="Archived" />}
      statusBar={null}
      main={
        <Page size="wide" data-testid="archived-projects-scroll">
          <PageHeader
            title={t("org.orgSidebar.archived")}
            description={
              tab === "files"
                ? "Files deleted from projects in this organization. Restore one to put it back in its project."
                : "Projects you've archived. Restore one to bring it back to the active list."
            }
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
              title={t("org.teamsList.selectOrgTitle")}
              description={t("org.archivedProjects.selectOrgDescription")}
            />
          ) : (
            <Tabs
              value={tab}
              onValueChange={(v) => setTab(v as ArchivedTab)}
            >
              <TabsList aria-label={t("org.archivedProjects.viewsAriaLabel")}>
                <TabsTrigger value="projects">{t("nav.projects")}</TabsTrigger>
                <TabsTrigger value="files">{t("nav.sidebarSection.trash")}</TabsTrigger>
              </TabsList>

              <TabsContent value="projects">
                <DataTable
                    columns={projectColumns}
                    data={projects}
                    loading={projectsLoading}
                    loadingLabel={t("org.archivedProjects.loadingLabel")}
                    getRowId={(p) => p.id}
                    initialSorting={[{ id: "archivedAt", desc: true }]}
                    searchPlaceholder="Search archived projects…"
                    globalFilterFn={(row, _columnId, filterValue) => {
                      const q = String(filterValue).trim().toLowerCase()
                      if (!q) return true
                      return row.original.name.toLowerCase().includes(q)
                    }}
                    renderRowMenuItems={(p) => (
                      <MenuItem
                        disabled={restoringId != null}
                        onClick={() => void handleRestoreProject(p.id)}
                      >
                        <ArchiveRestore className="size-4" />
                        {t("common.restore")}
                      </MenuItem>
                    )}
                    emptyState={(table) => {
                      if (projects.length === 0) {
                        return (
                          <TableEmptyState
                            icon={NAV_PAGE_ICONS.archived}
                            title={t("org.archivedProjects.emptyTitle")}
                            description={t("org.archivedProjects.emptyDescription")}
                          />
                        )
                      }
                      return (
                        <div className="flex flex-col items-center gap-3 py-10">
                          <p className="text-center text-sm text-muted-foreground">
                            {t("org.archivedProjects.noSearchMatch")}
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
                    testId="org-archived-projects-table"
                    className={ADMIN_TABLE_PANEL_CLASS}
                    dense
                  />
              </TabsContent>

              <TabsContent value="files">
                <DataTable
                    columns={fileColumns}
                    data={files}
                    loading={filesLoading || !filesLoaded}
                    loadingLabel={t("org.archivedProjects.loadingDeletedFilesLabel")}
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
                    renderRowMenuItems={(f) => (
                      <MenuItem
                        disabled={restoringId != null}
                        onClick={() => void handleRestoreFile(f)}
                      >
                        <ArchiveRestore className="size-4" />
                        {t("common.restore")}
                      </MenuItem>
                    )}
                    emptyState={(table) => {
                      if (files.length === 0) {
                        return (
                          <TableEmptyState
                            icon={NAV_PAGE_ICONS.file}
                            title={t("workspace.trash.empty")}
                            description={t("org.archivedProjects.noDeletedFilesDescription")}
                          />
                        )
                      }
                      return (
                        <div className="flex flex-col items-center gap-3 py-10">
                          <p className="text-center text-sm text-muted-foreground">
                            {t("org.archivedProjects.noDeletedFilesSearchMatch")}
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
                    testId="org-deleted-files-table"
                    className={ADMIN_TABLE_PANEL_CLASS}
                    dense
                  />
              </TabsContent>
            </Tabs>
          )}
        </Page>
      }
    />
  )
}
