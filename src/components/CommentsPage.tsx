// Project-wide comments page. Shows all threaded comments across every scope,
// grouped by file/cell. Resolved threads are collapsed by default.
//
// Uses the v3 event-log backed useComments hook (comment.* event grammar).
//
// AQU-185: filter/sort/show-resolved/navigate/@mention/FTS
// AQU-1958: CSV export of the visible list; the thread card and filter bar now
// live in comments-thread-card.tsx / comments-filter-controls.tsx, shared with
// the org-wide comments view.

import { useMemo, useState } from "react"
import { useNavigate, useParams } from "react-router-dom"
import { MessageCircle, AlertCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { Card, CardContent } from "@/components/ui/card"
import { EmptyState } from "@/components/ui/empty"
import { Badge } from "@/components/ui/badge"
import { useComments } from "@/hooks/useComments"
import { editorCommentHref } from "@/components/project-workspace-lane-deeplink"
import type { CommentRecord } from "@/lib/sync/comments-read-types"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { buildFileScopedTokenFetcher } from "@/lib/sync/cqrs-bridge"
import { useProject } from "@/hooks/useProject"
import type { ProjectRecord } from "@/lib/parsers/types"
import { stripAgentCommentMarker } from "@/lib/comments/comment-helpers"
import { commentsCsvBlob, commentsCsvFilename } from "@/lib/comments/comments-csv"
import { downloadBlob } from "@/lib/export/export-service"
import { useT } from "@/lib/i18n/I18nProvider"
import {
  type FilterState,
  DEFAULT_FILTER,
  applyFilters,
  applySorting,
  countActiveFilters,
  headerBadgeCount,
  resolveFileName,
} from "./comments-page-filters"
import { cellPlaceKey, useCommentCellPlaces } from "./comments-cell-preview"
import { CommentThreadCard } from "./comments-thread-card"
import { CommentsFilterControls } from "./comments-filter-controls"
import { buildCommentCsvThreads } from "./comments-export-threads"

interface CommentsPageProps {
  /** Reuse the workspace's already-resolved project for file labels instead
   * of starting a second project query when this pane opens. */
  project?: ProjectRecord | null
}

export function CommentsPage({ project: workspaceProject }: CommentsPageProps = {}) {
  const t = useT()
  const { id: projectId } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { session } = useFrontierSession()
  const ownedProject = useProject(projectId ?? "", {
    initialProject: workspaceProject,
    enabled: workspaceProject == null,
    includeSettings: false,
  })
  const project = workspaceProject ?? ownedProject.project
  const [filter, setFilter] = useState<FilterState>(DEFAULT_FILTER)

  const getToken = useMemo(() => {
    if (!projectId || !session?.jwt) {
      return async (_fileId: string) => null as string | null
    }
    return buildFileScopedTokenFetcher(
      () => session.jwt,
      projectId,
    )
  }, [projectId, session?.jwt])

  const { comments, isLoading, isError, refresh } = useComments({
    projectId: projectId ?? null,
    getToken,
    author: session?.username ?? 'unknown',
    // AQU-640: on a cold load the page can mount before the session JWT is
    // available; getToken can only mint a real token once session.jwt exists.
    // Signal readiness so the auto-load fires when the token arrives instead of
    // bailing on the null token and requiring a manual Refresh.
    tokenReady: !!session?.jwt,
  })

  // Separate top-level threads from replies.
  const { roots, repliesByParent } = useMemo(() => {
    const roots: CommentRecord[] = []
    const repliesByParent = new Map<string, CommentRecord[]>()
    for (const c of comments) {
      if (c.parentCommentId === null) {
        roots.push(c)
      } else {
        const arr = repliesByParent.get(c.parentCommentId) ?? []
        arr.push(c)
        repliesByParent.set(c.parentCommentId, arr)
      }
    }
    return { roots, repliesByParent }
  }, [comments])

  // Build a stable fileId → display name map from the project's file list.
  // This is the single source of truth for names and existence checks.
  const fileMap = useMemo<Map<string, string>>(() => {
    const map = new Map<string, string>()
    for (const f of project?.files ?? []) {
      map.set(f.id, f.name)
    }
    return map
  }, [project?.files])

  const places = useCommentCellPlaces(projectId, getToken, comments)

  // Derive unique file/author options for filter controls
  const { fileOptions, authorOptions } = useMemo(() => {
    const fileIds = new Set<string>()
    const authors = new Map<string, string>()
    for (const c of comments) {
      if (c.fileId) fileIds.add(c.fileId)
      // AQU-1233: one filter entry per person — drop the "(via agent)" marker
      // an agent-posted comment carries, or the filter for a real translator
      // reads as their tool depending on which comment was seen last.
      authors.set(c.authorId, stripAgentCommentMarker(c.authorLabel ?? c.authorId))
    }
    // Resolve each fileId to its display name; tombstone deleted files
    const fileOptions = Array.from(fileIds)
      .map((id) => {
        const { name } = resolveFileName(id, fileMap, t)
        return { id, name }
      })
      .sort((a, b) => a.name.localeCompare(b.name))
    return {
      fileOptions,
      authorOptions: Array.from(authors.entries())
        .map(([id, label]) => ({ id, label }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    }
  }, [comments, fileMap, t])

  // Apply filter + sort
  const displayedRoots = useMemo(() => {
    const filtered = applyFilters(roots, repliesByParent, filter)
    return applySorting(filtered, filter.sort)
  }, [roots, repliesByParent, filter])

  function handleNavigate(root: CommentRecord) {
    if (!projectId || !root.fileId) return
    // Only navigate to live files (tombstoned files have no route to open)
    const { exists } = resolveFileName(root.fileId, fileMap, t)
    if (!exists) return
    // AQU-1259: ?cellId= scrolls to the row, and `&comments=1` opens that
    // cell's thread on arrival. `commentId` names the message they clicked —
    // a reply lower in the thread — so the drawer scrolls to it instead of
    // stopping at the first comment.
    navigate(editorCommentHref(projectId, root.fileId, root.cellId, root.commentId))
  }

  // AQU-1958: the export is the visible list, filters and sort included — what
  // is on screen is what lands in the file.
  function handleExport() {
    const label = project?.name ?? t("common.comments")
    const threads = buildCommentCsvThreads({
      roots: displayedRoots,
      repliesByParent,
      projectNames: new Map(projectId ? [[projectId, project?.name ?? ""]] : []),
      fileMap,
      places,
      t,
    })
    downloadBlob(commentsCsvBlob(threads), commentsCsvFilename(label))
  }

  const activeFilterCount = countActiveFilters(filter)

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-8">
      <div className="flex items-center gap-2">
        <MessageCircle className="h-5 w-5 text-muted-foreground" />
        <h1 className="text-xl font-semibold">
          {project?.name
            ? t("comments.page.titleWithProject", { projectName: project.name })
            : t("common.comments")}
        </h1>
        {comments.length > 0 && (
          <Badge variant="secondary" data-testid="comments-count-badge">
            {headerBadgeCount(comments.length, displayedRoots.length, activeFilterCount)}
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
        isRefreshing={isLoading}
        onRefresh={refresh}
        onExport={handleExport}
        exportDisabled={displayedRoots.length === 0}
      />

      {isError && (
        <Card className="border-destructive">
          <CardContent className="flex items-center gap-2 py-3 text-sm text-destructive">
            <AlertCircle className="h-4 w-4 shrink-0" />
            {t("comments.loadError")}
          </CardContent>
        </Card>
      )}

      {isLoading && roots.length === 0 && (
        <div className="flex justify-center py-12">
          <Spinner className="size-8 text-muted-foreground" />
        </div>
      )}

      {!isLoading && !isError && roots.length === 0 && (
        <EmptyState
          icon={MessageCircle}
          title={t("comments.empty.title")}
          description={t("comments.empty.body")}
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
              fileMap={fileMap}
              place={
                root.fileId && root.cellId
                  ? places.get(cellPlaceKey(root.fileId, root.cellId))
                  : undefined
              }
              onNavigate={handleNavigate}
            />
          ))}
        </div>
      )}
    </div>
  )
}
