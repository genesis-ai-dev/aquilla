// Org-wide comments page (AQU-1958). BGP's editorial leads review feedback
// across the Oromo/Russian/Ukrainian/Marathi projects and had to open each
// project's Comments page in turn; this is the same list across every project
// in the org they can see, with the same filters and the same CSV export.
//
// Access is the server's, not this page's: the org project list is already
// filtered to the caller's access, and each project's comments are read with a
// sync-token scoped to that project. The Maintainer floor below decides who
// gets the *surface* — it cannot widen what the reads return.

import { useMemo, useState, type ReactNode } from "react"
import { useNavigate } from "react-router-dom"
import { AlertCircle, Building2, Lock, MessageCircle } from "lucide-react"
import { AppShell } from "@/components/AppShell"
import { OrgSidebar } from "@/components/org/OrgSidebar"
import { OrgBreadcrumb } from "@/components/org/OrgBreadcrumb"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { EmptyState, Page, PageHeader } from "@/components/ui/page"
import { Spinner } from "@/components/ui/spinner"
import { CommentsFilterControls } from "@/components/comments-filter-controls"
import { CommentThreadCard } from "@/components/comments-thread-card"
import { buildCommentCsvThreads } from "@/components/comments-export-threads"
import { editorCommentHref } from "@/components/project-workspace-lane-deeplink"
import {
  applyFilters,
  applySorting,
  countActiveFilters,
  DEFAULT_FILTER,
  resolveFileName,
  type FilterState,
} from "@/components/comments-page-filters"
import { useActiveOrg } from "@/context/OrgContext"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { useOrgComments } from "@/hooks/useOrgComments"
import { splitCommentThreads } from "@/lib/comments/comment-threads"
import {
  orgAuthorFilterOptions,
  orgFileFilterOptions,
  orgFileNames,
  orgProjectFilterOptions,
  orgProjectNames,
} from "@/lib/comments/org-comments"
import { commentsCsvBlob, commentsCsvFilename } from "@/lib/comments/comments-csv"
import { downloadBlob } from "@/lib/export/export-service"
import { ROLE } from "@/lib/frontier/roles"
import { useT } from "@/lib/i18n/I18nProvider"
import type { CommentRecord } from "@/lib/sync/comments-read-types"

export function OrgCommentsPage() {
  const t = useT()
  const { activeOrg, activeOrgId, activeGuestOrg, isAllOrgs } = useActiveOrg()
  // A guest org is project-level access with no org membership (AQU-790), so
  // there is no org-wide surface to offer there.
  const isMemberOrg = !isAllOrgs && activeOrgId != null && activeGuestOrg == null
  const canView = isMemberOrg && (activeOrg?.role.level ?? 0) >= ROLE.MAINTAINER

  let body: ReactNode
  if (!isMemberOrg) {
    body = (
      <EmptyState
        icon={Building2}
        title={t("org.teamsList.selectOrgTitle")}
        description={t("comments.org.selectOrgDescription")}
      />
    )
  } else if (!canView) {
    body = <EmptyState icon={Lock} title={t("comments.org.roleRequired")} />
  } else {
    // Keyed by org so filter state resets on an org switch.
    body = (
      <OrgCommentsBody
        key={activeOrgId}
        orgId={activeOrgId}
        orgName={activeOrg?.name ?? t("comments.org.title")}
      />
    )
  }

  return (
    <AppShell
      sidebar={<OrgSidebar />}
      header={<OrgBreadcrumb section={t("comments.org.title")} />}
      statusBar={null}
      main={
        <Page size="full">
          {canView ? null : (
            <PageHeader
              title={t("comments.org.title")}
              description={t("comments.org.description")}
            />
          )}
          {body}
        </Page>
      }
    />
  )
}

function OrgCommentsBody({ orgId, orgName }: { orgId: number; orgName: string }) {
  const t = useT()
  const navigate = useNavigate()
  const { session } = useFrontierSession()
  const { comments, projects, isLoading, failedProjects, error, refresh } = useOrgComments({
    orgId,
    jwt: session?.jwt ?? null,
  })
  const [filter, setFilter] = useState<FilterState>(DEFAULT_FILTER)

  const { roots, repliesByParent } = useMemo(() => splitCommentThreads(comments), [comments])
  const projectNames = useMemo(() => orgProjectNames(projects), [projects])
  const fileNames = useMemo(() => orgFileNames(projects), [projects])
  const projectOptions = useMemo(
    () => orgProjectFilterOptions(projects, comments),
    [projects, comments],
  )
  const authorOptions = useMemo(() => orgAuthorFilterOptions(comments), [comments])
  const fileOptions = useMemo(
    () => orgFileFilterOptions(comments, fileNames, filter.projectId),
    [comments, fileNames, filter.projectId],
  )

  const displayedRoots = useMemo(
    () => applySorting(applyFilters(roots, repliesByParent, filter), filter.sort),
    [roots, repliesByParent, filter],
  )
  const activeFilterCount = countActiveFilters(filter)

  function handleNavigate(root: CommentRecord) {
    if (!root.fileId) return
    // A tombstoned file has no route to open — same rule as the project page.
    if (!resolveFileName(root.fileId, fileNames, t).exists) return
    navigate(editorCommentHref(root.projectId, root.fileId, root.cellId, root.commentId))
  }

  function handleExport() {
    const threads = buildCommentCsvThreads({
      roots: displayedRoots,
      repliesByParent,
      projectNames,
      fileMap: fileNames,
      t,
    })
    // Named for the org, the way the project page's export is named for the project.
    downloadBlob(commentsCsvBlob(threads), commentsCsvFilename(orgName))
  }

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 p-8">
      <div className="flex items-center gap-2">
        <MessageCircle className="h-5 w-5 text-muted-foreground" />
        <h1 className="text-xl font-semibold">{t("comments.org.title")}</h1>
        {displayedRoots.length > 0 && (
          <Badge variant="secondary" data-testid="org-comments-count-badge">
            {displayedRoots.length}
          </Badge>
        )}
        {activeFilterCount > 0 && (
          <Badge variant="outline" className="text-[10px]">
            {activeFilterCount > 1
              ? t("comments.filterCount.other", { count: activeFilterCount })
              : t("comments.filterCount.one", { count: activeFilterCount })}
          </Badge>
        )}
      </div>

      <CommentsFilterControls
        filter={filter}
        onChange={setFilter}
        fileOptions={fileOptions}
        authorOptions={authorOptions}
        projectOptions={projectOptions}
        showDateRange
        isRefreshing={isLoading}
        onRefresh={refresh}
        onExport={handleExport}
        exportDisabled={displayedRoots.length === 0}
      />

      {error && (
        <Card className="border-destructive">
          <CardContent className="flex items-center gap-2 py-3 text-sm text-destructive">
            <AlertCircle className="h-4 w-4 shrink-0" />
            {error}
          </CardContent>
        </Card>
      )}

      {/* A project that failed is named, not dropped: a short list that looks
          complete reads as "no feedback", which is the wrong conclusion. */}
      {failedProjects.length > 0 && (
        <Card className="border-destructive">
          <CardContent className="flex items-center gap-2 py-3 text-sm text-destructive">
            <AlertCircle className="h-4 w-4 shrink-0" />
            {t("comments.org.partialError", { projects: failedProjects.join(", ") })}
          </CardContent>
        </Card>
      )}

      {isLoading && roots.length === 0 && (
        <div className="flex justify-center py-12">
          <Spinner className="size-8 text-muted-foreground" />
        </div>
      )}

      {!isLoading && !error && roots.length === 0 && (
        <EmptyState
          icon={MessageCircle}
          title={t("comments.empty.title")}
          description={t("comments.org.empty.body")}
        />
      )}

      {roots.length > 0 && displayedRoots.length === 0 && (
        <EmptyState
          icon={MessageCircle}
          title={activeFilterCount > 0
            ? t("comments.noMatch.title")
            : t("comments.empty.noneVisible")}
          action={activeFilterCount > 0 ? (
            <Button type="button" variant="outline" onClick={() => setFilter(DEFAULT_FILTER)}>
              {t("comments.noMatch.clear")}
            </Button>
          ) : undefined}
        />
      )}

      {displayedRoots.length > 0 && (
        <div className="space-y-2">
          {displayedRoots.map((root) => (
            <CommentThreadCard
              key={root.commentId}
              root={root}
              replies={repliesByParent.get(root.commentId) ?? []}
              fileMap={fileNames}
              projectLabel={projectNames.get(root.projectId)}
              onNavigate={handleNavigate}
            />
          ))}
        </div>
      )}
    </div>
  )
}
