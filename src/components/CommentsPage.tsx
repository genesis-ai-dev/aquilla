// Project-wide comments page. Shows all threaded comments across every scope,
// grouped by file/cell. Resolved threads are collapsed by default.
//
// Uses the v3 event-log backed useComments hook (comment.* event grammar).
//
// FRO-185: filter/sort/show-resolved/navigate/@mention/FTS

import { useMemo, useState, useRef, useEffect } from "react"
import { useNavigate, useParams } from "react-router-dom"
import {
  ArrowLeft, MessageCircle, CheckCircle, ChevronDown, ChevronRight,
  Loader2, AlertCircle, Search, SlidersHorizontal, ArrowUpRight,
  MoreHorizontal, Pencil, Trash2,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { useComments } from "@/hooks/useComments"
import type { CommentRecord } from "@/lib/sync/comments-read-types"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { buildFileScopedTokenFetcher } from "@/lib/sync/cqrs-bridge"
import { useProject } from "@/hooks/useProject"
import { renderCommentHtml } from "@/lib/comments/comment-helpers"
import DOMPurify from "dompurify"
import { useUserSearch, type UserSearchResult } from "@/hooks/useUserSearch"
import {
  Popover,
  PopoverContent,
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

// ── Types ─────────────────────────────────────────────────────────────────

export type SortOrder = "recent-activity" | "creation" | "unresolved-first"

export interface FilterState {
  fileId: string    // "" = all
  authorId: string  // "" = all
  participant: string // "" = all
  showResolved: boolean
  search: string    // client-side substring search over body
  sort: SortOrder
}

export const DEFAULT_FILTER: FilterState = {
  fileId: "",
  authorId: "",
  participant: "",
  showResolved: false,
  search: "",
  sort: "unresolved-first",
}

// ── Pure filter/sort helpers (testable) ───────────────────────────────────

export function applyFilters(
  roots: CommentRecord[],
  repliesByParent: Map<string, CommentRecord[]>,
  filter: FilterState,
): CommentRecord[] {
  return roots.filter((root) => {
    // show-resolved toggle
    if (!filter.showResolved && root.resolved) return false

    // file filter
    if (filter.fileId && root.fileId !== filter.fileId) return false

    // author filter — matches root author
    if (filter.authorId && root.authorId !== filter.authorId) return false

    // participant filter — root author OR any reply author
    if (filter.participant) {
      const replies = repliesByParent.get(root.commentId) ?? []
      const allAuthors = [root.authorId, ...replies.map((r) => r.authorId)]
      if (!allAuthors.includes(filter.participant)) return false
    }

    // body search — substring over root body + replies
    if (filter.search.trim()) {
      const needle = filter.search.trim().toLowerCase()
      const haystack = [
        root.body,
        ...(repliesByParent.get(root.commentId) ?? []).map((r) => r.body),
      ]
        .join(" ")
        .toLowerCase()
      // SWARM-TODO: wire true FTS5 endpoint when available (pass ?q= to sync-worker)
      if (!haystack.includes(needle)) return false
    }

    return true
  })
}

export function applySorting(roots: CommentRecord[], sort: SortOrder): CommentRecord[] {
  const copy = [...roots]
  if (sort === "unresolved-first") {
    copy.sort((a, b) => {
      if (a.resolved !== b.resolved) return a.resolved ? 1 : -1
      return b.createdAt - a.createdAt
    })
  } else if (sort === "creation") {
    copy.sort((a, b) => b.createdAt - a.createdAt)
  } else if (sort === "recent-activity") {
    copy.sort((a, b) => b.updatedAt - a.updatedAt)
  }
  return copy
}

// ── Helpers ───────────────────────────────────────────────────────────────

function formatTs(ms: number): string {
  try {
    return new Date(ms).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    })
  } catch {
    return String(ms)
  }
}

/** Resolve a fileId to a display name, or return a tombstone if not found. */
export function resolveFileName(
  fileId: string | null | undefined,
  fileMap: Map<string, string>,
): { name: string; exists: boolean } {
  if (!fileId) return { name: "Unknown file", exists: false }
  const name = fileMap.get(fileId)
  if (name !== undefined) return { name, exists: true }
  return { name: "Deleted file", exists: false }
}

function scopeLabel(comment: CommentRecord, fileMap: Map<string, string>): string {
  if (comment.scopeKind === "cell") {
    const { name } = resolveFileName(comment.fileId, fileMap)
    return `Cell ${comment.cellId ?? "?"} in ${name}`
  }
  if (comment.scopeKind === "file") {
    const { name } = resolveFileName(comment.fileId, fileMap)
    return `File ${name}`
  }
  return "Project"
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
      <textarea
        ref={textareaRef}
        value={value}
        onChange={handleChange}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        rows={rows}
        className={cn(
          "neu-inset w-full resize-none rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-ring",
          className
        )}
      />
      {mentionOpen && (
        <div className="absolute left-0 right-0 top-full mt-0.5 z-50 max-h-48 overflow-y-auto rounded-md border bg-popover shadow-md">
          {needsMorePrefix && (
            <p className="px-3 py-2 text-[11px] text-muted-foreground">Type more to search…</p>
          )}
          {!needsMorePrefix && isLoading && (
            <p className="flex items-center gap-1.5 px-3 py-2 text-[11px] text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" /> Searching…
            </p>
          )}
          {!needsMorePrefix && !isLoading && results.length === 0 && mentionQuery.length >= 2 && (
            <p className="px-3 py-2 text-[11px] text-muted-foreground">No users found.</p>
          )}
          {results.length > 0 && (
            <ul className="py-0.5">
              {results.map((u) => (
                <li key={u.id}>
                  <button
                    type="button"
                    onClick={() => insertMention(u)}
                    className="flex w-full items-center px-3 py-1.5 text-left text-sm hover:bg-muted"
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
  const isDeleted = comment.deletedAt !== null
  const isOwn = !!currentUsername && comment.authorId === currentUsername
  const canMutate = isOwn && !isDeleted

  return (
    <div className={cn("flex flex-col gap-0.5", comment.parentCommentId ? "pl-6" : "")}>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{comment.authorLabel ?? comment.authorId}</span>
        <span>{formatTs(comment.createdAt)}</span>
        {comment.updatedAt !== comment.createdAt && (
          <span className="italic">(edited)</span>
        )}
        {canMutate && onEdit && onDelete && (
          <Popover>
            <PopoverTrigger
              render={
                <button
                  type="button"
                  className="ml-auto flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                  aria-label="Comment actions"
                >
                  <MoreHorizontal className="h-3 w-3" />
                </button>
              }
            />
            <PopoverContent side="bottom" align="end" className="w-28 p-1">
              <button
                type="button"
                onClick={() => onEdit(comment.commentId, comment.body)}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-muted"
              >
                <Pencil className="h-3 w-3" />
                Edit
              </button>
              <button
                type="button"
                onClick={() => onDelete(comment.commentId)}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs text-destructive hover:bg-muted"
              >
                <Trash2 className="h-3 w-3" />
                Delete
              </button>
            </PopoverContent>
          </Popover>
        )}
      </div>
      {isDeleted ? (
        <p className="italic text-xs text-muted-foreground">[deleted]</p>
      ) : (
        // eslint-disable-next-line react/no-danger
        <div
          className="text-sm"
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
            <DialogTitle>Delete comment?</DialogTitle>
            <DialogDescription>
              This comment will be permanently removed. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={cancelDelete}>Cancel</Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={confirmDelete}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Collapsible open={open} onOpenChange={setOpen}>
        <Card className={cn("mb-3 overflow-hidden", root.resolved && "opacity-70")}>
          <CardHeader className="flex flex-row items-start gap-2 space-y-0 py-2 px-3">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-0.5">
                <span className="truncate">{scopeLabel(root, fileMap)}</span>
                {root.fileId && !resolveFileName(root.fileId, fileMap).exists && (
                  <Badge variant="outline" className="h-4 px-1 text-[10px] text-muted-foreground">
                    deleted
                  </Badge>
                )}
                {root.resolved && (
                  <Badge variant="secondary" className="h-4 px-1 text-[10px]">
                    <CheckCircle className="mr-0.5 h-2.5 w-2.5" />
                    resolved
                  </Badge>
                )}
              </div>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              {onNavigate && root.scopeKind === "cell" && root.fileId && root.cellId && (() => {
                const { exists } = resolveFileName(root.fileId, fileMap)
                return exists ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 px-2 text-xs"
                    title="Go to cell in editor"
                    onClick={() => onNavigate(root)}
                  >
                    <ArrowUpRight className="mr-0.5 h-3 w-3" />
                    Open file
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 px-2 text-xs cursor-not-allowed opacity-50"
                    title="File has been deleted"
                    disabled
                  >
                    <ArrowUpRight className="mr-0.5 h-3 w-3" />
                    Open file
                  </Button>
                )
              })()}
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-xs"
                onClick={() => onResolve(root.commentId, !root.resolved)}
              >
                {root.resolved ? "Reopen" : "Resolve"}
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
                        placeholder="Edit comment…"
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
                          size="sm"
                          className="h-6 px-2 text-xs"
                          onClick={saveEdit}
                          disabled={isSavingEdit || !editBody.trim()}
                        >
                          {isSavingEdit ? <Loader2 className="h-3 w-3 animate-spin" /> : "Save"}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 px-2 text-xs"
                          onClick={cancelEdit}
                          disabled={isSavingEdit}
                        >
                          Cancel
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
                  placeholder="Reply… (type @ to mention)"
                  rows={2}
                  onKeyDown={handleReplyKeyDown}
                />
                <p className="text-[10px] text-muted-foreground">
                  Replies from this view are not yet wired — open the cell in the editor to reply.
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

function FilterControls({ filter, onChange, fileOptions, authorOptions }: FilterControlsProps) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="space-y-2">
      {/* Search bar + expand toggle */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
          <Input
            className="pl-8 h-8 text-sm"
            placeholder="Search comments…"
            value={filter.search}
            onChange={(e) => onChange({ ...filter, search: e.target.value })}
          />
        </div>
        <Button
          size="sm"
          variant={expanded ? "secondary" : "outline"}
          className="h-8 gap-1.5 text-xs"
          onClick={() => setExpanded((v) => !v)}
        >
          <SlidersHorizontal className="h-3.5 w-3.5" />
          Filters
        </Button>
      </div>

      {expanded && (
        <div className="flex flex-wrap items-center gap-3 rounded-md border px-3 py-2 text-xs bg-muted/20">
          {/* Sort picker */}
          <label className="flex items-center gap-1.5">
            <span className="text-muted-foreground whitespace-nowrap">Sort</span>
            <select
              className="rounded border bg-background px-1.5 py-0.5 text-xs"
              value={filter.sort}
              onChange={(e) => onChange({ ...filter, sort: e.target.value as SortOrder })}
            >
              <option value="unresolved-first">Unresolved first</option>
              <option value="recent-activity">Most recent activity</option>
              <option value="creation">Newest first</option>
            </select>
          </label>

          {/* Show resolved toggle */}
          <label className="flex items-center gap-1.5 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={filter.showResolved}
              onChange={(e) => onChange({ ...filter, showResolved: e.target.checked })}
              className="h-3.5 w-3.5"
            />
            <span>Show resolved</span>
          </label>

          {/* File filter */}
          {fileOptions.length > 0 && (
            <label className="flex items-center gap-1.5">
              <span className="text-muted-foreground whitespace-nowrap">File</span>
              <select
                className="max-w-[180px] truncate rounded border bg-background px-1.5 py-0.5 text-xs"
                value={filter.fileId}
                onChange={(e) => onChange({ ...filter, fileId: e.target.value })}
              >
                <option value="">All files</option>
                {fileOptions.map((f) => (
                  <option key={f.id} value={f.id}>{f.name}</option>
                ))}
              </select>
            </label>
          )}

          {/* Author filter */}
          {authorOptions.length > 0 && (
            <label className="flex items-center gap-1.5">
              <span className="text-muted-foreground whitespace-nowrap">Author</span>
              <select
                className="rounded border bg-background px-1.5 py-0.5 text-xs"
                value={filter.authorId}
                onChange={(e) => onChange({ ...filter, authorId: e.target.value })}
              >
                <option value="">Anyone</option>
                {authorOptions.map((a) => (
                  <option key={a.id} value={a.id}>{a.label}</option>
                ))}
              </select>
            </label>
          )}

          {/* Participant filter */}
          {authorOptions.length > 0 && (
            <label className="flex items-center gap-1.5">
              <span className="text-muted-foreground whitespace-nowrap">Participant</span>
              <select
                className="rounded border bg-background px-1.5 py-0.5 text-xs"
                value={filter.participant}
                onChange={(e) => onChange({ ...filter, participant: e.target.value })}
              >
                <option value="">Anyone</option>
                {authorOptions.map((a) => (
                  <option key={a.id} value={a.id}>{a.label}</option>
                ))}
              </select>
            </label>
          )}

          {/* Reset */}
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-xs text-muted-foreground"
            onClick={() => onChange(DEFAULT_FILTER)}
          >
            Reset
          </Button>
        </div>
      )}
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────

export function CommentsPage() {
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
        const { name } = resolveFileName(id, fileMap)
        return { id, name }
      })
      .sort((a, b) => a.name.localeCompare(b.name))
    return {
      fileOptions,
      authorOptions: Array.from(authors.entries())
        .map(([id, label]) => ({ id, label }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    }
  }, [comments, fileMap])

  // Apply filter + sort
  const displayedRoots = useMemo(() => {
    const filtered = applyFilters(roots, repliesByParent, filter)
    return applySorting(filtered, filter.sort)
  }, [roots, repliesByParent, filter])

  function handleNavigate(root: CommentRecord) {
    if (!projectId || !root.fileId) return
    // Only navigate to live files (tombstoned files have no route to open)
    const { exists } = resolveFileName(root.fileId, fileMap)
    if (!exists) return
    // Append ?cellId= so ProjectWorkspace can scroll to the right cell on load.
    const params = root.cellId
      ? `?cellId=${encodeURIComponent(root.cellId)}`
      : ""
    navigate(`/project/${projectId}/file/${encodeURIComponent(root.fileId)}${params}`)
  }

  const activeFilterCount = [
    filter.fileId,
    filter.authorId,
    filter.participant,
    filter.showResolved ? "1" : "",
    filter.search,
  ].filter(Boolean).length

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-8">
      <div className="flex items-center justify-between">
        <Button variant="ghost" size="sm" onClick={() => navigate(`/project/${projectId}`)}>
          <ArrowLeft className="mr-2 h-4 w-4" /> Back to project
        </Button>
        <Button variant="outline" size="sm" onClick={refresh} disabled={isLoading}>
          {isLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Refresh"}
        </Button>
      </div>

      <div className="flex items-center gap-2">
        <MessageCircle className="h-5 w-5 text-muted-foreground" />
        <h1 className="text-xl font-semibold">
          {project?.name ? `${project.name} — ` : ""}Comments
        </h1>
        {comments.length > 0 && (
          <Badge variant="secondary">{comments.length}</Badge>
        )}
        {activeFilterCount > 0 && (
          <Badge variant="outline" className="text-[10px]">
            {activeFilterCount} filter{activeFilterCount > 1 ? "s" : ""}
          </Badge>
        )}
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
            Failed to load comments. Check your connection and try refreshing.
          </CardContent>
        </Card>
      )}

      {isLoading && roots.length === 0 && (
        <div className="flex justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      )}

      {!isLoading && !isError && roots.length === 0 && (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <MessageCircle className="h-10 w-10 text-muted-foreground" />
            <div className="text-lg font-medium">No comments yet</div>
            <p className="max-w-md text-sm text-muted-foreground">
              Comments can be added from the cell menu in the editor.
            </p>
          </CardContent>
        </Card>
      )}

      {roots.length > 0 && displayedRoots.length === 0 && (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-8 text-center">
            <Search className="h-8 w-8 text-muted-foreground" />
            <div className="text-base font-medium">No threads match your filters</div>
            <Button size="sm" variant="outline" onClick={() => setFilter(DEFAULT_FILTER)}>
              Clear filters
            </Button>
          </CardContent>
        </Card>
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
