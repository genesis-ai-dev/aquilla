import { useState, useEffect, useLayoutEffect, useMemo, useRef, type Ref } from "react"
import { ArrowUp, AlertTriangle, Check, ChevronsDownUp, ChevronsUpDown, Link, MessageCircleCheck, MoreHorizontal, Pencil, Trash2, Undo2 } from "lucide-react"
import { Collapsible as CollapsiblePrimitive } from "@base-ui/react/collapsible"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { MenuItem, MenuSeparator, createMenuHandle } from "@/components/ui/menu-parts"
import { Kbd, KbdGroup } from "@/components/ui/kbd"
import { AppTooltip } from "@/components/ui/tooltip"
import { altClickModifierLabel, isApplePlatform } from "@/lib/platform"
import { InitialsAvatar } from "@/components/InitialsAvatar"
import { UsernameWithAvatar } from "@/components/UsernameWithAvatar"
import { MentionTextarea } from "@/components/MentionTextarea"
import type { MentionCandidate } from "@/lib/comments/mention-suggest"
import type { CommentMessage, CommentThread as ThreadData } from "@/lib/parsers/types"
import { renderCommentHtml, isThreadStale } from "@/lib/comments/comment-helpers"
import DOMPurify from "dompurify"
import { cn } from "@/lib/utils"
import { useI18n } from "@/lib/i18n/I18nProvider"
import { DateTooltip } from "@/components/ui/date-tooltip"
import { editorCommentHref } from "@/components/project-workspace-lane-deeplink"
import {
  ownerScopedLocalStorageKey,
  subscribeClientLocalStorageOwner,
} from "@/lib/frontier/client-local-storage"

interface CommentThreadProps {
  thread: ThreadData
  currentTranslated: string
  canReply?: boolean
  canResolve?: boolean
  /**
   * AQU-1000: why resolve is denied on THIS thread. When present and
   * `canResolve` is false, the resolve controls render disabled with this as
   * their tooltip rather than vanishing — `09-design-and-ux.md` → "Never
   * disable silently". Omit it to keep the older hide-entirely behaviour, which
   * is what local / git-imported projects (no role, no reason to give) want.
   */
  resolveDenialReason?: string | null
  onReply: (text: string) => void
  onResolve: (closingMessage?: string) => void
  onReopen: () => void
  /** Rewrite one comment in the thread. Absent when nothing here can be edited. */
  onEdit?: (messageId: string, text: string) => void
  /** Remove one comment in the thread. Absent when nothing here can be deleted. */
  onDelete?: (messageId: string) => void
  /** Used when the caller does not pass a per-message check. */
  canEdit?: boolean
  canDelete?: boolean
  canEditMessage?: (message: CommentMessage) => boolean
  canDeleteMessage?: (message: CommentMessage) => boolean
  projectId?: string
  fileId?: string
  cellId?: string
  /** Project members the reply box may @mention. */
  mentionRoster?: readonly MentionCandidate[]
  /** Signed-in username, left out of the mention list. */
  currentUsername?: string | null
  /**
   * A comment inside this thread to scroll into view and highlight. Set when
   * a notification (or another deep link) names a specific reply.
   */
  highlightCommentId?: string | null
}

function draftKey(projectId: string | undefined, cellId: string | undefined, threadId: string): string {
  return ownerScopedLocalStorageKey(
    `comment-draft:${projectId ?? "unknown"}:${cellId ?? "unknown"}:${threadId}`,
  )
}

function readDraft(storageKey: string): string {
  if (typeof window === "undefined") return ""
  try { return localStorage.getItem(storageKey) ?? "" } catch { return "" }
}

export function CommentThread({ thread, currentTranslated, canReply = true, canResolve = true, resolveDenialReason, onReply, onResolve, onReopen, onEdit, onDelete, canEdit = false, canDelete = false, canEditMessage, canDeleteMessage, projectId, fileId, cellId, mentionRoster = [], currentUsername, highlightCommentId }: CommentThreadProps) {
  const { t, locale } = useI18n()
  const highlightRef = useRef<HTMLLIElement>(null)
  const [, setOwnerRevision] = useState(0)
  useEffect(() => subscribeClientLocalStorageOwner(() => {
    setOwnerRevision((revision) => revision + 1)
  }), [])
  // AQU-1000: three states, not two. Offered (enabled), refused-with-a-reason
  // (disabled + tooltip), or absent (no role context to explain).
  const showResolveDenied = !canResolve && !!resolveDenialReason
  const storageKey = draftKey(projectId, cellId, thread.id)
  const [draft, setDraft] = useState(() => ({ storageKey, text: readDraft(storageKey) }))
  // Never expose the previous key's draft during the render in which an owner,
  // project, cell, or thread changes. React restarts this render immediately,
  // before effects can persist the old text into the new namespace.
  if (draft.storageKey !== storageKey) {
    setDraft({ storageKey, text: readDraft(storageKey) })
  }
  const replyText = draft.storageKey === storageKey ? draft.text : readDraft(storageKey)
  const setReplyText = (text: string) => setDraft({ storageKey, text })
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editText, setEditText] = useState("")
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const isStale = isThreadStale(thread.createdForTranslated, currentTranslated)
  const resolved = thread.status === "resolved"
  // The drawer hands every thread the same link id. Only the thread that
  // actually holds that comment should open and recolor.
  const highlightedHere =
    highlightCommentId != null && thread.messages.some((message) => message.id === highlightCommentId)
  const [expanded, setExpanded] = useState(() => !resolved || highlightedHere)
  const wasResolvedRef = useRef(resolved)
  useEffect(() => {
    const becameResolved = !wasResolvedRef.current && thread.status === "resolved"
    wasResolvedRef.current = thread.status === "resolved"
    if (highlightedHere) {
      setExpanded(true)
      return
    }
    if (becameResolved) setExpanded(false)
  }, [thread.status, highlightedHere])
  const authors = new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(
    [...new Set(thread.messages.map((message) => message.author).filter(Boolean))],
  )
  const resolvedSummary = t("comments.thread.resolvedSummary", {
    count: thread.messages.length,
    authors,
  })

  // Persist draft to localStorage whenever it changes
  useEffect(() => {
    if (typeof window === "undefined") return
    if (draft.storageKey !== storageKey) return
    try {
      if (replyText) {
        localStorage.setItem(storageKey, replyText)
      } else {
        localStorage.removeItem(storageKey)
      }
    } catch { /* ignore quota errors */ }
  }, [draft.storageKey, replyText, storageKey])

  // The border flash is wayfinding, not a permanent selection. It leaves
  // after a few seconds; the comment stays where the scroll put it.
  const [litCommentId, setLitCommentId] = useState<string | null>(highlightedHere ? highlightCommentId : null)
  useEffect(() => {
    if (!highlightedHere || !highlightCommentId) {
      setLitCommentId(null)
      return
    }
    setLitCommentId(highlightCommentId)
    const timer = window.setTimeout(() => {
      setLitCommentId((current) => (current === highlightCommentId ? null : current))
    }, COMMENT_HIGHLIGHT_MS)
    return () => window.clearTimeout(timer)
  }, [highlightCommentId, highlightedHere])

  // A link that names one reply has to move that reply into view. Remember
  // the id we already scrolled so a re-render of the same thread does not
  // yank the list back while the reader is looking further down.
  const scrolledIdRef = useRef<string | null>(null)
  useLayoutEffect(() => {
    if (!highlightedHere) {
      scrolledIdRef.current = null
      return
    }
    // The message is not in the document until a resolved thread opens, so
    // wait for that paint instead of giving up on the first pass.
    if (!highlightedHere || !expanded) return
    const el = highlightRef.current
    if (!el || scrolledIdRef.current === highlightCommentId) return
    scrolledIdRef.current = highlightCommentId
    scrollCommentIntoView(el)
  }, [highlightCommentId, highlightedHere, expanded, thread.messages])

  function handleReply() {
    if (!replyText.trim()) return
    onReply(replyText)
    setReplyText("")
  }

  function handleCloseWithReply() {
    if (!replyText.trim()) return
    onResolve(replyText)
    setReplyText("")
  }

  function handleReplyKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key !== "Enter" || e.shiftKey || e.metaKey || e.ctrlKey || e.nativeEvent.isComposing) return
    e.preventDefault()
    if (e.altKey) {
      if (!canResolve || !replyText.trim()) return
      handleCloseWithReply()
      return
    }
    handleReply()
  }

  // SECURITY: comment text is rendered through renderCommentHtml which escapes
  // HTML and then adds a narrow set of tags (b, i, code, br, span). DOMPurify
  // at the render boundary is additional defense-in-depth.
  function safeCommentHtml(text: string): string {
    return DOMPurify.sanitize(renderCommentHtml(text), {
      ALLOWED_TAGS: ["b", "i", "code", "br", "span"],
      ALLOWED_ATTR: ["class"],
    })
  }

  const threadBody = (
    <>
      <ul className="divide-y">
        {thread.messages.map((message, index) => (
          // The menu's focus guards render next to the row. A bare row would
          // become a list sibling, and divide-y would paint a second line on
          // the reply border while the menu is open.
          <li key={message.id}>
          <CommentMessageRow
            message={message}
            stale={index === 0 && isStale}
            lit={litCommentId === message.id}
            highlightRef={highlightCommentId === message.id ? highlightRef : undefined}
            editing={editingId === message.id}
            editText={editText}
            onEditText={setEditText}
            onStartEdit={() => {
              setEditText(message.text)
              setEditingId(message.id)
            }}
            onCancelEdit={() => setEditingId(null)}
            onSaveEdit={() => {
              const next = editText.trim()
              if (!next || !editingId || !onEdit) return
              onEdit(editingId, next)
              setEditingId(null)
            }}
            onAskDelete={() => setDeletingId(message.id)}
            canEdit={canEditMessage ? canEditMessage(message) : canEdit}
            canDelete={canDeleteMessage ? canDeleteMessage(message) : canDelete}
            status={thread.status}
            canResolve={canResolve}
            showResolveDenied={showResolveDenied}
            resolveDenialReason={resolveDenialReason}
            onResolve={() => onResolve()}
            onReopen={onReopen}
            projectId={projectId}
            fileId={fileId}
            cellId={cellId}
            mentionRoster={mentionRoster}
            currentUsername={currentUsername}
            safeHtml={safeCommentHtml(message.text)}
          />
          </li>
        ))}
      </ul>

      {thread.status === "open" && canReply && (
        <div className="flex items-start gap-2 border-t p-2">
          {currentUsername && <InitialsAvatar name={currentUsername} size="xs" className="mt-1" />}
          <div className="min-w-0 flex-1">
          <MentionTextarea
            value={replyText}
            onChange={setReplyText}
            onKeyDown={handleReplyKeyDown}
            candidates={mentionRoster}
            currentUsername={currentUsername}
            placeholder={t("comments.thread.replyPlaceholder")}
            rows={1}
            className="resize-none border-0 px-0 py-1 shadow-none focus-visible:border-transparent data-[empty=true]:before:start-0 data-[empty=true]:before:top-1"
          />
          </div>
          <div className="self-end">
            <AppTooltip
              align="end"
              content={
                <span className="flex flex-col gap-1">
                  <span className="inline-flex items-center gap-1.5">
                    <Kbd>Enter</Kbd>
                    {t("comments.thread.enterReply")}
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <KbdGroup>
                      <Kbd aria-label={altClickModifierLabel()}>{isApplePlatform() ? "⌥" : "Alt"}</Kbd>
                      <Kbd>Enter</Kbd>
                    </KbdGroup>
                    {t("comments.thread.optionEnterResolve")}
                  </span>
                </span>
              }
            >
              <Button
                type="button"
                size="icon-xs"
                variant={replyText.trim() ? "default" : "outline"}
                aria-label={t("comments.thread.reply")}
                onClick={handleReply}
                disabled={!replyText.trim()}
              >
                <ArrowUp />
              </Button>
            </AppTooltip>
          </div>
        </div>
      )}
    </>
  )

  const deleteDialog = (
    <Dialog open={deletingId != null} onOpenChange={(open) => { if (!open) setDeletingId(null) }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("comments.deleteDialog.title")}</DialogTitle>
          <DialogDescription>{t("comments.deleteDialog.description")}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => setDeletingId(null)}>
            {t("common.cancel")}
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={() => {
              const id = deletingId
              setDeletingId(null)
              if (id) onDelete?.(id)
            }}
          >
            {t("common.delete")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )

  if (resolved) {
    return (
      <>
        {deleteDialog}
        <CollapsiblePrimitive.Root
        data-slot="collapsible"
        open={expanded}
        onOpenChange={setExpanded}
        className="rounded-lg border text-sm"
      >
        {expanded ? (
          <>
            <CollapsiblePrimitive.Trigger
              data-slot="collapsible-trigger"
              className="flex w-full items-center gap-2 border-b p-2 text-start text-muted-foreground outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
            >
              <span className="min-w-0 flex-1">{t("comments.thread.collapse")}</span>
              <ChevronsDownUp className="size-4 shrink-0" aria-hidden />
            </CollapsiblePrimitive.Trigger>
            <CollapsiblePrimitive.Panel data-slot="collapsible-content">{threadBody}</CollapsiblePrimitive.Panel>
          </>
        ) : (
          <ContextMenu>
            <ContextMenuTrigger render={<div />}>
              <CollapsiblePrimitive.Trigger data-slot="collapsible-trigger" className="flex w-full items-center gap-2 p-2 text-start outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring">
                <MessageCircleCheck className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                <span className="min-w-0 flex-1 truncate">{resolvedSummary}</span>
                <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              </CollapsiblePrimitive.Trigger>
            </ContextMenuTrigger>
            <ContextMenuContent className="min-w-44">
              {(canResolve || showResolveDenied) && (
                <MenuItem
                  data-testid="comment-reopen"
                  aria-disabled={showResolveDenied || undefined}
                  className={cn(showResolveDenied && "cursor-not-allowed opacity-50")}
                  onClick={showResolveDenied ? undefined : onReopen}
                >
                  <Undo2 />
                  {t("comments.thread.reopen")}
                </MenuItem>
              )}
              {showResolveDenied && resolveDenialReason && (
                <p className="px-2 pb-1 text-[11px] text-muted-foreground">{resolveDenialReason}</p>
              )}
              {thread.messages[0] && (canDeleteMessage ? canDeleteMessage(thread.messages[0]) : canDelete) && (
                <MenuItem onClick={() => setDeletingId(thread.messages[0].id)}>
                  <Trash2 />
                  {t("common.delete")}
                </MenuItem>
              )}
            </ContextMenuContent>
          </ContextMenu>
        )}
        </CollapsiblePrimitive.Root>
      </>
    )
  }

  return (
    <>
      {deleteDialog}
      <div className="rounded-lg border text-sm">{threadBody}</div>
    </>
  )
}

/**
 * One comment row. The ⋯ button and a right-click open the same actions.
 * The button's menu uses a handle so it is not swallowed by the context-menu
 * root wrapped around the row.
 */
function CommentMessageRow({
  message,
  stale,
  lit,
  highlightRef,
  editing,
  editText,
  onEditText,
  onStartEdit,
  onCancelEdit,
  onSaveEdit,
  onAskDelete,
  canEdit,
  canDelete,
  status,
  canResolve,
  showResolveDenied,
  resolveDenialReason,
  onResolve,
  onReopen,
  projectId,
  fileId,
  cellId,
  mentionRoster,
  currentUsername,
  safeHtml,
}: {
  message: CommentMessage
  stale: boolean
  lit: boolean
  highlightRef?: Ref<HTMLLIElement>
  editing: boolean
  editText: string
  onEditText: (text: string) => void
  onStartEdit: () => void
  onCancelEdit: () => void
  onSaveEdit: () => void
  onAskDelete: () => void
  canEdit: boolean
  canDelete: boolean
  status: "open" | "resolved"
  canResolve: boolean
  showResolveDenied: boolean
  resolveDenialReason?: string | null
  onResolve: () => void
  onReopen: () => void
  projectId?: string
  fileId?: string
  cellId?: string
  mentionRoster: readonly MentionCandidate[]
  currentUsername?: string | null
  safeHtml: string
}) {
  const { t } = useI18n()
  const actionsMenu = useMemo(() => createMenuHandle(), [])
  const actions = (
    <CommentActionItems
      commentId={message.id}
      status={status}
      canResolve={canResolve}
      showResolveDenied={showResolveDenied}
      resolveDenialReason={resolveDenialReason}
      onResolve={onResolve}
      onReopen={onReopen}
      canEdit={canEdit}
      canDelete={canDelete}
      onEdit={onStartEdit}
      onDelete={onAskDelete}
      projectId={projectId}
      fileId={fileId}
      cellId={cellId}
    />
  )

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger
          render={
            <div
              ref={highlightRef}
              data-comment-id={message.id}
              data-focused={lit ? "true" : undefined}
              className={cn("group/comment p-2", lit && "ring-1 ring-inset ring-primary")}
            />
          }
        >
          <div className="flex items-center gap-1.5 text-xs">
            <UsernameWithAvatar username={message.author} size="xs" nameClassName="text-xs" />
            <span className="text-muted-foreground">
              <DateTooltip
                value={message.timestamp}
                label=""
                variant="ago"
                side="top"
                editedAt={message.editedAt}
                editedNotice={t("comments.bubble.edited")}
              />
            </span>
            {stale && (
              <AppTooltip content={t("comments.stale.tooltip")}>
                <span className="flex items-center gap-0.5 text-amber-500">
                  <AlertTriangle className="h-3 w-3" /> {t("comments.stale.badge")}
                </span>
              </AppTooltip>
            )}
            <DropdownMenuTrigger
              handle={actionsMenu}
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="ms-auto [@media(hover:hover)_and_(pointer:fine)]:opacity-0 [@media(hover:hover)_and_(pointer:fine)]:group-hover/comment:opacity-100 [@media(hover:hover)_and_(pointer:fine)]:focus-visible:opacity-100 [@media(hover:hover)_and_(pointer:fine)]:aria-expanded:opacity-100 [@media(hover:hover)_and_(pointer:fine)]:data-popup-open:opacity-100"
                  aria-label={t("comments.thread.actionsAria")}
                  onClick={(event) => event.stopPropagation()}
                />
              }
            >
              <MoreHorizontal />
            </DropdownMenuTrigger>
          </div>
          {editing ? (
            <div className="mt-1 ps-7">
              <MentionTextarea
                value={editText}
                onChange={onEditText}
                candidates={mentionRoster}
                currentUsername={currentUsername}
                placeholder={t("comments.composer.editPlaceholder")}
                autoHeight
                caretAtEnd
                className="min-h-5 border-0 bg-transparent p-0 text-sm shadow-none rounded-none focus-visible:border-transparent focus-visible:ring-0 data-[empty=true]:before:start-0 data-[empty=true]:before:top-0"
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    onCancelEdit()
                    return
                  }
                  if (e.key !== "Enter" || e.shiftKey || e.metaKey || e.ctrlKey || e.altKey || e.nativeEvent.isComposing) return
                  e.preventDefault()
                  onSaveEdit()
                }}
              />
              <div className="mt-1.5 flex justify-end gap-1.5">
                <Button type="button" size="xs" variant="ghost" onClick={onCancelEdit}>
                  {t("common.cancel")}
                </Button>
                <Button type="button" size="xs" disabled={!editText.trim()} onClick={onSaveEdit}>
                  {t("common.save")}
                </Button>
              </div>
            </div>
          ) : (
            <div
              className="mt-1 ps-7 text-sm select-text"
              data-ph-mask=""
              dangerouslySetInnerHTML={{ __html: safeHtml }}
            />
          )}
        </ContextMenuTrigger>
        <ContextMenuContent className="min-w-44">{actions}</ContextMenuContent>
      </ContextMenu>
      <DropdownMenu handle={actionsMenu}>
        <DropdownMenuContent align="end" className="min-w-44">
          <CommentActionItems
            commentId={message.id}
            status={status}
            canResolve={canResolve}
            showResolveDenied={showResolveDenied}
            resolveDenialReason={resolveDenialReason}
            onResolve={onResolve}
            onReopen={onReopen}
            canEdit={canEdit}
            canDelete={canDelete}
            onEdit={onStartEdit}
            onDelete={onAskDelete}
            projectId={projectId}
            fileId={fileId}
            cellId={cellId}
          />
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  )
}

/**
 * Edit, resolve (or reopen), copy this comment's link, delete.
 * Resolve stays when the role cannot do it, with the reason written out.
 */
function CommentActionItems({
  commentId,
  status,
  canResolve,
  showResolveDenied,
  resolveDenialReason,
  onResolve,
  onReopen,
  canEdit,
  canDelete,
  onEdit,
  onDelete,
  projectId,
  fileId,
  cellId,
}: {
  commentId: string
  status: "open" | "resolved"
  canResolve: boolean
  showResolveDenied: boolean
  resolveDenialReason?: string | null
  onResolve: () => void
  onReopen: () => void
  canEdit: boolean
  canDelete: boolean
  onEdit: () => void
  onDelete: () => void
  projectId?: string
  fileId?: string
  cellId?: string
}) {
  const { t } = useI18n()
  const showResolve = status === "open" && (canResolve || showResolveDenied)
  const showReopen = status === "resolved" && (canResolve || showResolveDenied)

  async function copyUrl() {
    if (!projectId || !fileId || !cellId) return
    const path = editorCommentHref(projectId, fileId, cellId, commentId)
    try {
      await navigator.clipboard.writeText(new URL(path, window.location.origin).href)
    } catch {
      /* clipboard blocked — the link is still the menu's job to offer */
    }
  }

  return (
    <>
      {canEdit && (
        <MenuItem onClick={onEdit}>
          <Pencil />
          {t("common.edit")}
        </MenuItem>
      )}
      {showResolve && (
        <MenuItem
          data-testid="comment-resolve"
          aria-disabled={showResolveDenied || undefined}
          className={cn(showResolveDenied && "cursor-not-allowed opacity-50")}
          onClick={showResolveDenied ? undefined : onResolve}
        >
          <Check />
          {t("comments.thread.resolve")}
        </MenuItem>
      )}
      {showResolveDenied && resolveDenialReason && (
        <p className="px-2 pb-1 text-[11px] text-muted-foreground">{resolveDenialReason}</p>
      )}
      {showReopen && (
        <MenuItem
          data-testid="comment-reopen"
          aria-disabled={showResolveDenied || undefined}
          className={cn(showResolveDenied && "cursor-not-allowed opacity-50")}
          onClick={showResolveDenied ? undefined : onReopen}
        >
          <Undo2 />
          {t("comments.thread.reopen")}
        </MenuItem>
      )}
      <MenuItem onClick={() => { void copyUrl() }}>
        <Link />
        {t("comments.thread.copyUrl")}
      </MenuItem>
      {canDelete && (
        <>
          <MenuSeparator />
          <MenuItem onClick={onDelete}>
            <Trash2 />
            {t("common.delete")}
          </MenuItem>
        </>
      )}
    </>
  )
}

/** How long a jumped-to comment stays highlighted. */
export const COMMENT_HIGHLIGHT_MS = 8000

/** Move a reply into the comments list. `scrollIntoView` also scrolls
 * overflow-hidden ancestors, which leaves the drawer's own list unmoved. */
function scrollCommentIntoView(el: HTMLElement) {
  const scroller = el.closest<HTMLElement>("[data-comments-scroll]")
  if (!scroller) {
    el.scrollIntoView({ block: "center", behavior: "smooth" })
    return
  }
  const elRect = el.getBoundingClientRect()
  const box = scroller.getBoundingClientRect()
  const top = scroller.scrollTop + (elRect.top - box.top) - (box.height - elRect.height) / 2
  scroller.scrollTo({ top: Math.max(0, top), behavior: "smooth" })
}
