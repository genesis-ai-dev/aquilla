// Project-wide comments page. Shows all threaded comments across every scope,
// grouped by file/cell. Resolved threads are collapsed by default.
//
// Uses the v3 event-log backed useComments hook (comment.* event grammar).
//
// AQU-185: filter/sort/show-resolved/navigate/@mention/FTS

import { useMemo, useState } from "react"
import { useNavigate, useParams } from "react-router-dom"
import {
  MessageCircle, MessageCircleCheck,
  AlertCircle, Search, Settings2, RefreshCw,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { AppTooltip } from "@/components/ui/tooltip"
import { Spinner } from "@/components/ui/spinner"
import { Card, CardContent } from "@/components/ui/card"
import { EmptyState } from "@/components/ui/empty"
import { Badge } from "@/components/ui/badge"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group"
import { UserChip } from "@/components/UserChip"
import { useComments } from "@/hooks/useComments"
import { editorCommentHref } from "@/components/project-workspace-lane-deeplink"
import type { CommentRecord } from "@/lib/sync/comments-read-types"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { buildFileScopedTokenFetcher } from "@/lib/sync/cqrs-bridge"
import { useProject } from "@/hooks/useProject"
import type { ProjectRecord } from "@/lib/parsers/types"
import { renderCommentHtml, stripAgentCommentMarker } from "@/lib/comments/comment-helpers"
import DOMPurify from "dompurify"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useT, useI18n } from "@/lib/i18n/I18nProvider"
import type { TFunction } from "@/lib/i18n/I18nProvider"
import { DateTooltip } from "@/components/ui/date-tooltip"
import { Separator } from "@/components/ui/separator"
import { Switch } from "@/components/ui/switch"
import {
  type FilterState,
  type SortOrder,
  DEFAULT_FILTER,
  applyFilters,
  applySorting,
  countActiveFilters,
  headerBadgeCount,
  resolveFileName,
} from "./comments-page-filters"
import { cellPlaceKey, formatScriptureRef, useCommentCellPlaces } from "./comments-cell-preview"

function sortItems(t: TFunction): { value: SortOrder; label: string }[] {
  return [
    { value: "unresolved-first", label: t("comments.sort.unresolvedFirst") },
    { value: "recent-activity", label: t("comments.sort.recentActivity") },
    { value: "creation", label: t("comments.sort.newest") },
  ]
}

function scopeLabel(comment: CommentRecord, fileMap: Map<string, string>, t: TFunction): string {
  if (comment.scopeKind === "file") {
    const { name } = resolveFileName(comment.fileId, fileMap, t)
    return t("comments.scope.file", { file: name })
  }
  return t("common.project")
}

function CellPlace({
  root,
  place,
  fileMap,
  t,
}: {
  root: CommentRecord
  place?: string
  fileMap: Map<string, string>
  t: TFunction
}) {
  if (root.scopeKind === "cell") {
    const label = place || formatScriptureRef(root.cellRef)
    if (label) return <span className="min-w-0 flex-1 truncate">{label}</span>
    return <span className="min-w-0 flex-1 truncate">{resolveFileName(root.fileId, fileMap, t).name}</span>
  }
  return <span className="min-w-0 flex-1 truncate">{scopeLabel(root, fileMap, t)}</span>
}

function safeCommentHtml(text: string): string {
  return DOMPurify.sanitize(renderCommentHtml(text), {
    ALLOWED_TAGS: ["b", "i", "code", "br", "span"],
    ALLOWED_ATTR: ["class"],
  })
}

function PageCommentRow({
  comment,
  isRoot,
  fileMissing,
  place,
  fileMap,
  root,
  onNavigate,
}: {
  comment: CommentRecord
  isRoot: boolean
  fileMissing: boolean
  place?: string
  fileMap: Map<string, string>
  root: CommentRecord
  onNavigate?: (comment: CommentRecord) => void
}) {
  const { t } = useI18n()
  return (
    <button
      type="button"
      onClick={() => onNavigate?.(comment)}
      disabled={!onNavigate}
      className="block w-full p-2 text-start outline-none hover:bg-accent/40 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-default"
    >
      {isRoot && (
        <div className="mb-1 flex items-center gap-1.5 text-xs text-muted-foreground">
          <CellPlace root={root} place={place} fileMap={fileMap} t={t} />
          {fileMissing && (
            <Badge variant="outline" className="h-4 px-1 text-[10px] text-muted-foreground">
              {t("comments.file.deletedBadge")}
            </Badge>
          )}
        </div>
      )}
      <div className="flex items-center gap-1.5 text-xs">
        <UserChip
          username={comment.authorLabel ?? comment.authorId}
          size="xs"
          nameClassName="text-xs"
        />
        <span className="text-muted-foreground">
          <DateTooltip
            value={comment.createdAt}
            label=""
            variant="ago"
            side="top"
            editedAt={comment.deletedAt ? null : comment.updatedAt}
            editedNotice={t("comments.bubble.edited")}
          />
        </span>
      </div>
      {comment.deletedAt != null ? (
        <p className="mt-1 ps-7 text-sm text-muted-foreground">{t("comments.bubble.deletedBody")}</p>
      ) : (
        <div
          data-ph-mask=""
          className="mt-1 ps-7 text-sm select-text"
          dangerouslySetInnerHTML={{ __html: safeCommentHtml(comment.body) }}
        />
      )}
    </button>
  )
}


// ── Thread (top-level + replies) ─────────────────────────────────────────

interface ThreadProps {
  root: CommentRecord
  replies: CommentRecord[]
  fileMap: Map<string, string>
  /** Book, chapter, and verse for this thread's cell, when the read has landed. */
  place?: string
  onNavigate?: (root: CommentRecord) => void
}

function CommentThreadCard({
  root, replies, fileMap, place, onNavigate,
}: ThreadProps) {
  const { t, locale } = useI18n()

  const messages = [root, ...replies]
  const authors = new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(
    [...new Set(messages.map((message) => message.authorLabel ?? message.authorId))],
  )
  const resolvedSummary = t("comments.thread.resolvedSummary", {
    count: messages.length,
    authors,
  })
  const fileMissing = !!root.fileId && !resolveFileName(root.fileId, fileMap, t).exists

  const threadBody = (
    <>
      <ul className="divide-y">
        {messages.map((comment, index) => (
          <li key={comment.commentId}>
            <PageCommentRow
              comment={comment}
              isRoot={index === 0}
              fileMissing={fileMissing}
              place={place}
              fileMap={fileMap}
              root={root}
              onNavigate={onNavigate}
            />
          </li>
        ))}
      </ul>
    </>
  )

  const shell = root.resolved ? (
    <button
      type="button"
      onClick={() => onNavigate?.(root)}
      disabled={!onNavigate}
      className="flex w-full items-center gap-2 rounded-lg border bg-card p-2 text-start text-sm outline-none hover:bg-accent/40 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-default"
    >
      <MessageCircleCheck className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 flex-1 truncate">{resolvedSummary}</span>
    </button>
  ) : (
    <div className="rounded-lg border bg-card text-sm">{threadBody}</div>
  )

  return shell
}

// ── Filter/sort controls ──────────────────────────────────────────────────

interface FilterControlsProps {
  filter: FilterState
  onChange: (next: FilterState) => void
  fileOptions: { id: string; name: string }[]
  authorOptions: { id: string; label: string }[]
  isRefreshing: boolean
  onRefresh: () => void
}

const filterLabelClass = "font-normal text-muted-foreground"
/** Matches FieldGroup `gap-3` so select popups sit the same distance from their trigger. */
const FILTER_MENU_GAP_PX = 12

/** Base UI treats "" as no value (`data-placeholder`), which mutes the trigger. */
const ALL_SELECT_VALUE = "__all__"

function toSelectValue(value: string) {
  return value === "" ? ALL_SELECT_VALUE : value
}

function fromSelectValue(value: string | null) {
  return value == null || value === ALL_SELECT_VALUE ? "" : value
}

function FilterSelectRow({
  id,
  label,
  items,
  value,
  onValueChange,
  side = "bottom",
}: {
  id: string
  label: string
  items: { value: string; label: string }[]
  value: string
  onValueChange: (value: string) => void
  side?: "top" | "bottom"
}) {
  const selectItems = items.map((item) => ({
    ...item,
    value: toSelectValue(item.value),
  }))
  return (
    <Field orientation="horizontal" className="items-center justify-between gap-3">
      <FieldLabel htmlFor={id} className={filterLabelClass}>
        {label}
      </FieldLabel>
      <Select
        items={selectItems}
        value={toSelectValue(value)}
        onValueChange={(next) => onValueChange(fromSelectValue(next))}
      >
        <SelectTrigger id={id} size="sm" aria-label={label}>
          <SelectValue className="truncate" />
        </SelectTrigger>
        <SelectContent
          align="end"
          side={side}
          alignItemWithTrigger={false}
          sideOffset={FILTER_MENU_GAP_PX}
        >
          <SelectGroup>
            {selectItems.map((item) => (
              <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </Field>
  )
}

function FilterControls({
  filter,
  onChange,
  fileOptions,
  authorOptions,
  isRefreshing,
  onRefresh,
}: FilterControlsProps) {
  const t = useT()
  const [menuOpen, setMenuOpen] = useState(false)
  const sortItemsList = sortItems(t)
  const allFilesLabel = t("comments.filter.allFiles")
  const anyoneLabel = t("comments.filter.anyone")
  const showResolvedLabel = t("comments.filter.showResolved")
  const activeFilterCount = countActiveFilters(filter)
  const canReset = activeFilterCount > 0 || filter.sort !== DEFAULT_FILTER.sort
  const hasFiles = fileOptions.length > 0
  const hasAuthors = authorOptions.length > 0

  return (
    <div className="flex items-center gap-2">
      <InputGroup className="h-8 flex-1 bg-card">
        <InputGroupAddon>
          <Search />
        </InputGroupAddon>
        <InputGroupInput
          className="text-sm"
          placeholder={t("comments.filter.searchPlaceholder")}
          value={filter.search}
          onChange={(e) => onChange({ ...filter, search: e.target.value })}
        />
      </InputGroup>
      <Popover open={menuOpen} onOpenChange={setMenuOpen}>
        <AppTooltip
          content={t("comments.filter.filtersButton")}
          side="bottom"
          disabled={menuOpen}
        >
          <PopoverTrigger
            render={
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="bg-card"
                aria-label={t("comments.filter.filtersButton")}
                aria-pressed={activeFilterCount > 0}
              >
                <Settings2 />
              </Button>
            }
          />
        </AppTooltip>
        <PopoverContent
          align="end"
          side="bottom"
          sideOffset={4}
          className="w-72 gap-0 p-0"
          data-testid="comments-filters-popover"
        >
          <PopoverTitle className="sr-only">{t("comments.filter.filtersButton")}</PopoverTitle>
          <FieldGroup className="gap-3 p-2.5">
            <FilterSelectRow
              id="comments-filter-sort"
              label={t("comments.filter.sortLabel")}
              items={sortItemsList}
              value={filter.sort}
              onValueChange={(value) => onChange({ ...filter, sort: value as SortOrder })}
              side={!hasFiles && !hasAuthors ? "top" : "bottom"}
            />
            <Field orientation="horizontal">
              <FieldLabel htmlFor="comments-filter-show-resolved" className={filterLabelClass}>
                {showResolvedLabel}
              </FieldLabel>
              <Switch
                id="comments-filter-show-resolved"
                checked={filter.showResolved}
                onCheckedChange={(checked) => onChange({ ...filter, showResolved: checked })}
                aria-label={showResolvedLabel}
              />
            </Field>
            {hasFiles && (
              <FilterSelectRow
                id="comments-filter-file"
                label={t("common.file")}
                items={[
                  { value: "", label: allFilesLabel },
                  ...fileOptions.map((file) => ({ value: file.id, label: file.name })),
                ]}
                value={filter.fileId}
                onValueChange={(value) => onChange({ ...filter, fileId: value })}
                side={!hasAuthors ? "top" : "bottom"}
              />
            )}
            {hasAuthors && (
              <FilterSelectRow
                id="comments-filter-author"
                label={t("comments.filter.authorLabel")}
                items={[
                  { value: "", label: anyoneLabel },
                  ...authorOptions.map((author) => ({ value: author.id, label: author.label })),
                ]}
                value={filter.authorId}
                onValueChange={(value) => onChange({ ...filter, authorId: value })}
              />
            )}
            {hasAuthors && (
              <FilterSelectRow
                id="comments-filter-participant"
                label={t("comments.filter.participantLabel")}
                items={[
                  { value: "", label: anyoneLabel },
                  ...authorOptions.map((author) => ({ value: author.id, label: author.label })),
                ]}
                value={filter.participant}
                onValueChange={(value) => onChange({ ...filter, participant: value })}
                side="top"
              />
            )}
          </FieldGroup>
          {canReset && (
            <>
              <Separator />
              <div className="flex justify-end p-2.5">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-foreground"
                  onClick={() => onChange(DEFAULT_FILTER)}
                >
                  {t("common.reset")}
                </Button>
              </div>
            </>
          )}
        </PopoverContent>
      </Popover>
      <AppTooltip content={t("common.refresh")} side="bottom" align="end">
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="bg-card"
          onClick={onRefresh}
          disabled={isRefreshing}
          aria-label={t("common.refresh")}
        >
          {isRefreshing ? <Spinner /> : <RefreshCw />}
        </Button>
      </AppTooltip>
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────

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

      <FilterControls
        filter={filter}
        onChange={setFilter}
        fileOptions={fileOptions}
        authorOptions={authorOptions}
        isRefreshing={isLoading}
        onRefresh={refresh}
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
