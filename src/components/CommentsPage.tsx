// Project-wide comments page. Shows all threaded comments across every scope,
// grouped by file/cell. Resolved threads are collapsed by default.
//
// Uses the v3 event-log backed useComments hook (comment.* event grammar).
//
// AQU-185: filter/sort/show-resolved/navigate/@mention/FTS

import { useMemo, useState, useRef, useEffect } from "react"
import { useNavigate, useParams } from "react-router-dom"
import {
  MessageCircle, CheckCircle, ChevronDown, ChevronRight,
  AlertCircle, Search, Funnel, ArrowUpRight,
  MoreHorizontal, Pencil, Trash2, RefreshCw,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { AppTooltip } from "@/components/ui/tooltip"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { EmptyState } from "@/components/ui/empty"
import { Badge } from "@/components/ui/badge"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group"
import { cn } from "@/lib/utils"
import { UsernameWithAvatar } from "@/components/UsernameWithAvatar"
import { useComments } from "@/hooks/useComments"
import type { CommentRecord } from "@/lib/sync/comments-read-types"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { buildFileScopedTokenFetcher } from "@/lib/sync/cqrs-bridge"
import { useProject } from "@/hooks/useProject"
import { renderCommentHtml } from "@/lib/comments/comment-helpers"
import DOMPurify from "dompurify"
import { useUserSearch, type UserSearchResult } from "@/hooks/useUserSearch"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
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

function sortItems(t: TFunction): { value: SortOrder; label: string }[] {
  return [
    { value: "unresolved-first", label: t("comments.sort.unresolvedFirst") },
    { value: "recent-activity", label: t("comments.sort.recentActivity") },
    { value: "creation", label: t("comments.sort.newest") },
  ]
}

function scopeLabel(comment: CommentRecord, fileMap: Map<string, string>, t: TFunction): string {
  if (comment.scopeKind === "cell") {
    const { name } = resolveFileName(comment.fileId, fileMap, t)
    // AQU-599: prefer the human-readable cell reference (e.g. "GEN 1:1") the
    // server resolves from the source cell, so the panel shows the cell number
    // instead of the opaque cellId. Fall back to the raw id only when no
    // canonical ref is available (non-scripture / deleted cell / older worker).
    const cellLabel =
      comment.cellRef?.trim() || t("common.cellLabel", { id: comment.cellId ?? "?" })
    return t("comments.scope.cell", { cell: cellLabel, file: name })
  }
  if (comment.scopeKind === "file") {
    const { name } = resolveFileName(comment.fileId, fileMap, t)
    return t("comments.scope.file", { file: name })
  }
  return t("common.project")
}

// ── @mention typeahead in comment composer ────────────────────────────────

interface MentionTypeaheadProps {
  value: string
  onChange: (val: string) => void
  placeholder?: string
  rows?: number
  className?: string
  onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void
}

function MentionTextarea({
  value,
  onChange,
  placeholder,
  rows = 2,
  className,
  onKeyDown,
}: MentionTypeaheadProps) {
  const t = useT()
  const [mentionQuery, setMentionQuery] = useState("")
  const [mentionOpen, setMentionOpen] = useState(false)
  const [mentionStart, setMentionStart] = useState(0)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  const { results, isLoading, needsMorePrefix } = useUserSearch(
    mentionOpen ? mentionQuery : ""
  )

  // Close on outside click
  useEffect(() => {
    if (!mentionOpen) return
    function onDocClick(e: MouseEvent) {
      if (!containerRef.current?.contains(e.target as Node)) setMentionOpen(false)
    }
    document.addEventListener("mousedown", onDocClick)
    return () => document.removeEventListener("mousedown", onDocClick)
  }, [mentionOpen])

  function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const raw = e.target.value
    onChange(raw)

    const cursor = e.target.selectionStart ?? raw.length
    // Find the @ that opens the current mention token
    const textUpToCursor = raw.slice(0, cursor)
    const atIdx = textUpToCursor.lastIndexOf("@")
    if (atIdx !== -1) {
      const afterAt = textUpToCursor.slice(atIdx + 1)
      // Only trigger if there's no space after @
      if (!/\s/.test(afterAt)) {
        setMentionQuery(afterAt)
        setMentionStart(atIdx)
        setMentionOpen(true)
        return
      }
    }
    setMentionOpen(false)
  }

  function insertMention(result: UserSearchResult) {
    const before = value.slice(0, mentionStart)
    const after = value.slice(mentionStart + 1 + mentionQuery.length)
    const newVal = `${before}@${result.username} ${after}`
    onChange(newVal)
    setMentionOpen(false)
    // Re-focus
    setTimeout(() => {
      textareaRef.current?.focus()
    }, 0)
  }

  return (
    <div ref={containerRef} className="relative">
      <Textarea
        ref={textareaRef}
        value={value}
        onChange={handleChange}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        rows={rows}
        className={cn("resize-none", className)}
      />
      {mentionOpen && (
        <div className="absolute start-0 end-0 top-full mt-0.5 z-50 max-h-48 overflow-y-auto rounded-md border bg-popover shadow-md">
          {needsMorePrefix && (
            <p className="px-3 py-2 text-[11px] text-muted-foreground">{t("comments.mention.typeMore")}</p>
          )}
          {!needsMorePrefix && isLoading && (
            <p className="flex items-center gap-1.5 px-3 py-2 text-[11px] text-muted-foreground">
              <Spinner className="size-3" /> {t("common.searching")}
            </p>
          )}
          {!needsMorePrefix && !isLoading && results.length === 0 && mentionQuery.length >= 2 && (
            <p className="px-3 py-2 text-[11px] text-muted-foreground">{t("comments.mention.noResults")}</p>
          )}
          {results.length > 0 && (
            <ul className="py-0.5">
              {results.map((u) => (
                <li key={u.id}>
                  <button
                    type="button"
                    onClick={() => insertMention(u)}
                    className="flex w-full items-center px-3 py-1.5 text-start text-sm hover:bg-muted"
                  >
                    @{u.username}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

// ── Single comment bubble ─────────────────────────────────────────────────

interface CommentBubbleProps {
  comment: CommentRecord
  currentUsername?: string
  onEdit?: (commentId: string, currentBody: string) => void
  onDelete?: (commentId: string) => void
}

function CommentBubble({ comment, currentUsername, onEdit, onDelete }: CommentBubbleProps) {
  const { t } = useI18n()
  const isDeleted = comment.deletedAt !== null
  const isOwn = !!currentUsername && comment.authorId === currentUsername
  const canMutate = isOwn && !isDeleted

  return (
    <div className={cn("flex flex-col gap-0.5", comment.parentCommentId ? "ps-6" : "")}>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <UsernameWithAvatar
          username={comment.authorLabel ?? comment.authorId}
          size="xs"
          nameClassName="text-xs font-medium text-foreground"
        />
        <DateTooltip value={comment.createdAt} label={t("common.date.posted")} />
        {comment.updatedAt !== comment.createdAt && (
          <span className="italic">{t("comments.bubble.edited")}</span>
        )}
        {canMutate && onEdit && onDelete && (
          <Popover>
            <PopoverTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="ms-auto size-5"
                  aria-label={t("comments.bubble.actionsLabel")}
                >
                  <MoreHorizontal className="h-3 w-3" />
                </Button>
              }
            />
            <PopoverContent side="bottom" align="end" className="w-28 p-1">
              <button
                type="button"
                onClick={() => onEdit(comment.commentId, comment.body)}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-muted"
              >
                <Pencil className="h-3 w-3" />
                {t("common.edit")}
              </button>
              <button
                type="button"
                onClick={() => onDelete(comment.commentId)}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs text-destructive hover:bg-muted"
              >
                <Trash2 className="h-3 w-3" />
                {t("common.delete")}
              </button>
            </PopoverContent>
          </Popover>
        )}
      </div>
      {isDeleted ? (
        <p className="italic text-xs text-muted-foreground">{t("comments.bubble.deletedBody")}</p>
      ) : (
        // eslint-disable-next-line react/no-danger
        <div
          className="text-sm"
          // Session-replay mask (docs/OPSEC.md): comment bodies quote draft
          // text and name collaborators.
          data-ph-mask=""
          dangerouslySetInnerHTML={{
            __html: DOMPurify.sanitize(renderCommentHtml(comment.body), {
              ALLOWED_TAGS: ["b", "i", "code", "br", "span"],
              ALLOWED_ATTR: ["class"],
            }),
          }}
        />
      )}
    </div>
  )
}

// ── Thread (top-level + replies) ─────────────────────────────────────────

interface ThreadProps {
  root: CommentRecord
  replies: CommentRecord[]
  currentUsername?: string
  fileMap: Map<string, string>
  onResolve: (commentId: string, resolved: boolean) => void
  onEdit: (commentId: string, body: string) => Promise<void>
  onDelete: (commentId: string) => Promise<void>
  onNavigate?: (root: CommentRecord) => void
}

function CommentThreadCard({
  root, replies, currentUsername, fileMap, onResolve, onEdit, onDelete, onNavigate,
}: ThreadProps) {
  const t = useT()
  const [open, setOpen] = useState(!root.resolved)
  const [replyText, setReplyText] = useState("")

  // Inline edit state
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editBody, setEditBody] = useState("")
  const [isSavingEdit, setIsSavingEdit] = useState(false)

  // Delete confirm state
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [isDeletingConfirm, setIsDeletingConfirm] = useState(false)

  function handleReplyKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault()
      // Reply submit is a no-op here (CommentsPage is read-only for new replies)
      // The cell-scoped CommentThread.tsx handles replies in-editor.
    }
  }

  function startEdit(commentId: string, currentBody: string) {
    setEditingId(commentId)
    setEditBody(currentBody)
  }

  async function saveEdit() {
    if (!editingId || !editBody.trim()) return
    setIsSavingEdit(true)
    try {
      await onEdit(editingId, editBody.trim())
    } finally {
      setIsSavingEdit(false)
      setEditingId(null)
      setEditBody("")
    }
  }

  function cancelEdit() {
    setEditingId(null)
    setEditBody("")
  }

  function requestDelete(commentId: string) {
    setDeletingId(commentId)
    setIsDeletingConfirm(true)
  }

  async function confirmDelete() {
    if (!deletingId) return
    await onDelete(deletingId)
    setDeletingId(null)
    setIsDeletingConfirm(false)
  }

  function cancelDelete() {
    setDeletingId(null)
    setIsDeletingConfirm(false)
  }

  const allComments = [root, ...replies]

  return (
    <>
      <Dialog open={isDeletingConfirm} onOpenChange={(v) => { if (!v) cancelDelete() }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("comments.deleteDialog.title")}</DialogTitle>
            <DialogDescription>
              {t("comments.deleteDialog.description")}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={cancelDelete}>{t("common.cancel")}</Button>
            <Button
              variant="destructive"
              onClick={confirmDelete}
            >
              {t("common.delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Collapsible open={open} onOpenChange={setOpen}>
        <Card className={cn("mb-3 overflow-hidden", root.resolved && "opacity-70")}>
          <CardHeader className="flex flex-row items-start gap-2 space-y-0 py-2 px-3">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-0.5">
                <span className="truncate">{scopeLabel(root, fileMap, t)}</span>
                {root.fileId && !resolveFileName(root.fileId, fileMap, t).exists && (
                  <Badge variant="outline" className="h-4 px-1 text-[10px] text-muted-foreground">
                    {t("comments.file.deletedBadge")}
                  </Badge>
                )}
                {root.resolved && (
                  <Badge variant="secondary" className="h-4 px-1 text-[10px]">
                    <CheckCircle className="me-0.5 h-2.5 w-2.5" />
                    {t("comments.status.resolved")}
                  </Badge>
                )}
              </div>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              {onNavigate && root.scopeKind === "cell" && root.fileId && root.cellId && (() => {
                const { exists } = resolveFileName(root.fileId, fileMap, t)
                return exists ? (
                  <AppTooltip content={t("comments.goToCell")}>
                    <Button
                      variant="ghost"
                      className="h-6 px-2 text-xs"
                      onClick={() => onNavigate(root)}
                    >
                      <ArrowUpRight className="me-0.5 h-3 w-3" />
                      {t("comments.openFile")}
                    </Button>
                  </AppTooltip>
                ) : (
                  <AppTooltip content={t("comments.fileDeletedTooltip")}>
                    <Button
                      variant="ghost"
                      className="h-6 px-2 text-xs cursor-not-allowed opacity-50"
                      disabled
                    >
                      <ArrowUpRight className="me-0.5 h-3 w-3" />
                      {t("comments.openFile")}
                    </Button>
                  </AppTooltip>
                )
              })()}
              <Button
                variant="ghost"
                className="h-6 px-2 text-xs"
                onClick={() => onResolve(root.commentId, !root.resolved)}
              >
                {root.resolved ? t("comments.reopen") : t("comments.resolve")}
              </Button>
              <CollapsibleTrigger asChild>
                <Button size="icon" variant="ghost" className="h-6 w-6">
                  {open ? (
                    <ChevronDown className="h-3 w-3" />
                  ) : (
                    <ChevronRight className="h-3 w-3" />
                  )}
                </Button>
              </CollapsibleTrigger>
            </div>
          </CardHeader>
          <CollapsibleContent>
            <CardContent className="pt-0 px-3 pb-3 flex flex-col gap-3">
              {allComments.map((c) => (
                <div key={c.commentId}>
                  {editingId === c.commentId ? (
                    <div className="flex flex-col gap-1.5">
                      <MentionTextarea
                        value={editBody}
                        onChange={setEditBody}
                        placeholder={t("comments.composer.editPlaceholder")}
                        rows={3}
                        onKeyDown={(e) => {
                          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                            e.preventDefault()
                            void saveEdit()
                          }
                          if (e.key === "Escape") {
                            cancelEdit()
                          }
                        }}
                      />
                      <div className="flex gap-1.5">
                        <Button
                          className="h-6 px-2 text-xs"
                          onClick={saveEdit}
                          disabled={isSavingEdit || !editBody.trim()}
                        >
                          {isSavingEdit ? <Spinner className="size-3" /> : t("common.save")}
                        </Button>
                        <Button
                          variant="ghost"
                          className="h-6 px-2 text-xs"
                          onClick={cancelEdit}
                          disabled={isSavingEdit}
                        >
                          {t("common.cancel")}
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <CommentBubble
                      comment={c}
                      currentUsername={currentUsername}
                      onEdit={startEdit}
                      onDelete={requestDelete}
                    />
                  )}
                </div>
              ))}
              {/* Reply composer with @mention typeahead */}
              <div className="mt-1 space-y-1.5">
                <MentionTextarea
                  value={replyText}
                  onChange={setReplyText}
                  placeholder={t("comments.composer.replyPlaceholder")}
                  rows={2}
                  onKeyDown={handleReplyKeyDown}
                />
                <p className="text-[10px] text-muted-foreground">
                  {t("comments.reply.notWired")}
                  {/* SWARM-TODO: wire reply submission from CommentsPage when a cell-reply endpoint is available */}
                </p>
              </div>
            </CardContent>
          </CollapsibleContent>
        </Card>
      </Collapsible>
    </>
  )
}

// ── Filter/sort controls ──────────────────────────────────────────────────

interface FilterControlsProps {
  filter: FilterState
  onChange: (next: FilterState) => void
  fileOptions: { id: string; name: string }[]
  authorOptions: { id: string; label: string }[]
}

const filterLabelClass = "font-normal text-muted-foreground"

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
}: {
  id: string
  label: string
  items: { value: string; label: string }[]
  value: string
  onValueChange: (value: string) => void
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
        <SelectContent>
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

function FilterControls({ filter, onChange, fileOptions, authorOptions }: FilterControlsProps) {
  const t = useT()
  const [menuOpen, setMenuOpen] = useState(false)
  const sortItemsList = sortItems(t)
  const allFilesLabel = t("comments.filter.allFiles")
  const anyoneLabel = t("comments.filter.anyone")
  const showResolvedLabel = t("comments.filter.showResolved")
  const activeFilterCount = countActiveFilters(filter)
  const canReset = activeFilterCount > 0 || filter.sort !== DEFAULT_FILTER.sort

  return (
    <div className="flex items-center gap-2">
      <InputGroup className="h-8 flex-1">
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
                variant={menuOpen || activeFilterCount > 0 ? "secondary" : "outline"}
                size="icon"
                aria-label={t("comments.filter.filtersButton")}
              >
                <Funnel />
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
            {fileOptions.length > 0 && (
              <FilterSelectRow
                id="comments-filter-file"
                label={t("common.file")}
                items={[
                  { value: "", label: allFilesLabel },
                  ...fileOptions.map((file) => ({ value: file.id, label: file.name })),
                ]}
                value={filter.fileId}
                onValueChange={(value) => onChange({ ...filter, fileId: value })}
              />
            )}
            {authorOptions.length > 0 && (
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
            {authorOptions.length > 0 && (
              <FilterSelectRow
                id="comments-filter-participant"
                label={t("comments.filter.participantLabel")}
                items={[
                  { value: "", label: anyoneLabel },
                  ...authorOptions.map((author) => ({ value: author.id, label: author.label })),
                ]}
                value={filter.participant}
                onValueChange={(value) => onChange({ ...filter, participant: value })}
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
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────

export function CommentsPage() {
  const t = useT()
  const { id: projectId } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { session } = useFrontierSession()
  const { project } = useProject(projectId ?? "")
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

  const { comments, isLoading, isError, resolveThread, editComment, deleteComment, refresh } = useComments({
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

  // Derive unique file/author options for filter controls
  const { fileOptions, authorOptions } = useMemo(() => {
    const fileIds = new Set<string>()
    const authors = new Map<string, string>()
    for (const c of comments) {
      if (c.fileId) fileIds.add(c.fileId)
      authors.set(c.authorId, c.authorLabel ?? c.authorId)
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
    // Append ?cellId= so ProjectWorkspace can scroll to the right cell on load.
    const params = root.cellId
      ? `?cellId=${encodeURIComponent(root.cellId)}`
      : ""
    navigate(`/project/${projectId}/editor/file/${encodeURIComponent(root.fileId)}${params}`)
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
        <div className="flex-1" />
        <AppTooltip content={t("common.refresh")} side="bottom">
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={refresh}
            disabled={isLoading}
            aria-label={t("common.refresh")}
          >
            {isLoading ? <Spinner /> : <RefreshCw />}
          </Button>
        </AppTooltip>
      </div>

      <FilterControls
        filter={filter}
        onChange={setFilter}
        fileOptions={fileOptions}
        authorOptions={authorOptions}
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
        <div>
          {displayedRoots.map((root) => (
            <CommentThreadCard
              key={root.commentId}
              root={root}
              replies={repliesByParent.get(root.commentId) ?? []}
              currentUsername={session?.username}
              fileMap={fileMap}
              onResolve={resolveThread}
              onEdit={editComment}
              onDelete={deleteComment}
              onNavigate={handleNavigate}
            />
          ))}
        </div>
      )}
    </div>
  )
}
