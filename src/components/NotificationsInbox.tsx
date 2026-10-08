import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type Ref } from "react"
import { observeElementRect, useVirtualizer } from "@tanstack/react-virtual"
import { Bell, MailBadge, MailCheck, MailX, MoreHorizontal } from "lucide-react"
import { useNavigate } from "react-router-dom"
import { InitialsAvatar } from "@/components/InitialsAvatar"
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
import { MenuItem, MenuSeparator } from "@/components/ui/menu-parts"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { AppTooltip } from "@/components/ui/tooltip"
import { toast } from "@/components/ui/toast"
import { cn } from "@/lib/utils"
import { useT, type TFunction } from "@/lib/i18n/I18nProvider"
import { cellTextSnippet, mentionNoticesFor, type MentionNotice } from "@/lib/comments/mention-inbox"
import {
  dismissMentions,
  markMentionsRead,
  markMentionsUnread,
  restoreMentions,
  useMentionDismissedIds,
  useMentionReadIds,
} from "@/lib/store/mention-read-state"
import { editorCommentHref } from "@/components/project-workspace-lane-deeplink"
import type { CommentRecord } from "@/lib/sync/comments-read-types"

/** Rough row height. Rows truncate to two lines, so a fixed estimate is enough. */
const NOTICE_ROW_PX = 48

type PendingDelete =
  | { kind: "one"; commentId: string }
  | { kind: "all" }
  | { kind: "read" }

/**
 * In-app inbox for comment @mentions (AQU-761). Derived from comments already
 * loaded for the open project — there is no notification table. Read and
 * dismissed state live on this device. Dismissing a row hides it here; the
 * comment stays. Rows show the cell as the title, an unread dot inline with
 * that title, "{author} commented: {excerpt}" under it, and the time on the right.
 */
export function NotificationsInbox({
  projectId,
  readerUsername,
  comments,
  files = [],
  cellTextById,
}: {
  projectId: string
  readerUsername: string
  comments: readonly CommentRecord[]
  /** File names for a mention that sits on a file rather than a cell. */
  files?: readonly { id: string; name: string }[]
  /** Source text of cells loaded in the editor, keyed by cell id. */
  cellTextById?: ReadonlyMap<string, string>
}) {
  const t = useT()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [unreadsOnly, setUnreadsOnly] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null)
  // The confirm dialog is portaled outside the popover. Hold the inbox open
  // across that outside press, then release on the next turn.
  const holdOpen = useRef(false)
  const firstNoticeRef = useRef<HTMLButtonElement>(null)
  const readIds = useMentionReadIds(projectId, readerUsername)
  const dismissedIds = useMentionDismissedIds(projectId, readerUsername)
  const notices = useMemo(
    () =>
      mentionNoticesFor(comments, readerUsername).filter(
        (notice) => !dismissedIds.has(notice.commentId),
      ),
    [comments, readerUsername, dismissedIds],
  )
  const unread = notices.filter((notice) => !readIds.has(notice.commentId))
  const read = notices.filter((notice) => readIds.has(notice.commentId))
  // Newest first, the order mentionNoticesFor already produced. Marking a row
  // read only drops its dot; it does not sink to the bottom.
  const shown = unreadsOnly ? unread : notices

  function openNotice(notice: MentionNotice) {
    markMentionsRead(projectId, readerUsername, [notice.commentId])
    setOpen(false)
    if (notice.scopeKind === "cell" && notice.fileId && notice.cellId) {
      navigate(editorCommentHref(projectId, notice.fileId, notice.cellId, notice.commentId))
      return
    }
    navigate(`/project/${projectId}/comments`)
  }

  function dismissOne(commentId: string) {
    dismissMentions(projectId, readerUsername, [commentId])
    const toastId = `mention-dismiss:${projectId}:${commentId}`
    const action = t("comments.inbox.deletedToast")
    const icon = <MailX aria-hidden />
    let settled = false
    function undo() {
      if (settled) return
      settled = true
      restoreMentions(projectId, readerUsername, [commentId])
      toast.update(toastId, { actionProps: undefined, data: { icon } })
      toast.add({
        id: `mention-undone:${toastId}`,
        type: "success",
        title: t("comments.inbox.undoneToast", { action }),
      })
    }
    toast.add({
      id: toastId,
      title: action,
      timeout: 10_000,
      data: { undo, icon },
      actionProps: {
        children: t("comments.inbox.undo"),
        onClick: () => undo(),
      },
    })
  }

  function askDelete(pending: PendingDelete) {
    holdOpen.current = true
    setPendingDelete(pending)
  }

  function closeDeleteDialog() {
    setPendingDelete(null)
    queueMicrotask(() => {
      holdOpen.current = false
    })
  }

  function confirmDelete() {
    const pending = pendingDelete
    closeDeleteDialog()
    if (!pending) return
    const ids =
      pending.kind === "one"
        ? [pending.commentId]
        : pending.kind === "read"
          ? read.map((notice) => notice.commentId)
          : notices.map((notice) => notice.commentId)
    dismissMentions(projectId, readerUsername, ids)
  }

  const deleteCopy =
    pendingDelete?.kind === "all"
      ? { title: t("comments.inbox.deleteAllTitle"), description: t("comments.inbox.deleteAllDescription") }
      : pendingDelete?.kind === "read"
        ? { title: t("comments.inbox.deleteAllReadTitle"), description: t("comments.inbox.deleteAllReadDescription") }
        : { title: t("comments.inbox.deleteTitle"), description: t("comments.inbox.deleteDescription") }

  return (
    <>
      <Popover
        open={open}
        onOpenChange={(next) => {
          if (!next && holdOpen.current) return
          setOpen(next)
        }}
      >
        <PopoverTrigger
          render={
            <Button
              variant="ghost"
              size="icon"
              className="relative"
              aria-label={
                unread.length > 0
                  ? t("comments.inbox.openUnreadAria", { count: unread.length })
                  : t("comments.inbox.openAria")
              }
              data-testid="notifications-inbox-trigger"
            >
              <Bell className="size-4" />
              {unread.length > 0 && (
                <span
                  className="absolute -top-0.5 -end-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-medium text-primary-foreground"
                  data-testid="notifications-unread-count"
                >
                  {unread.length > 9 ? "9+" : unread.length}
                </span>
              )}
            </Button>
          }
        />
        <PopoverContent
          align="end"
          side="bottom"
          sideOffset={6}
          initialFocus={shown.length > 0 ? firstNoticeRef : undefined}
          className="flex max-h-[min(560px,calc(100vh-6rem))] w-[420px] max-w-[calc(100vw-2rem)] flex-col gap-2 overflow-hidden pt-2 pr-0 pb-0 pl-2"
        >
          <header className="flex shrink-0 items-center justify-between gap-2 pr-2">
            <h3 className="text-base font-semibold tracking-tight">{t("comments.inbox.title")}</h3>
            {notices.length > 0 && (
              <div className="flex items-center gap-1">
                <AppTooltip content={t("comments.inbox.unreadsOnly")}>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-pressed={unreadsOnly}
                    aria-label={t("comments.inbox.unreadsOnly")}
                    data-testid="notifications-unreads-only"
                    className={unreadsOnly ? "bg-accent text-foreground" : undefined}
                    onClick={() => setUnreadsOnly((value) => !value)}
                  >
                    <MailBadge />
                  </Button>
                </AppTooltip>
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t("comments.inbox.actionsAria")}
                        data-testid="notifications-actions"
                      />
                    }
                  >
                    <MoreHorizontal />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="min-w-44">
                    <MenuItem
                      disabled={unread.length === 0}
                      onClick={() =>
                        markMentionsRead(
                          projectId,
                          readerUsername,
                          notices.map((notice) => notice.commentId),
                        )
                      }
                    >
                      <MailCheck />
                      {t("comments.inbox.markAllRead")}
                    </MenuItem>
                    <MenuSeparator />
                    <MenuItem disabled={notices.length === 0} onClick={() => askDelete({ kind: "all" })}>
                      <MailX />
                      {t("comments.inbox.deleteAll")}
                    </MenuItem>
                    <MenuItem disabled={read.length === 0} onClick={() => askDelete({ kind: "read" })}>
                      <MailX />
                      {t("comments.inbox.deleteAllRead")}
                    </MenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            )}
          </header>

          {shown.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 px-3 py-10 text-center">
              <span className="flex size-9 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                <Bell className="size-4" aria-hidden />
              </span>
              <p className="text-sm font-medium">
                {notices.length === 0 ? t("comments.inbox.emptyTitle") : t("comments.inbox.noUnreadTitle")}
              </p>
              <p className="text-xs text-muted-foreground">
                {notices.length === 0 ? t("comments.inbox.empty") : t("comments.inbox.noUnread")}
              </p>
            </div>
          ) : (
            <NotificationList
              label={t("comments.inbox.title")}
              notices={shown}
              readIds={readIds}
              files={files}
              cellTextById={cellTextById}
              firstNoticeRef={firstNoticeRef}
              markReadLabel={t("comments.inbox.markRead")}
              markUnreadLabel={t("comments.inbox.markUnread")}
              deleteLabel={t("comments.inbox.delete")}
              t={t}
              onOpen={openNotice}
              onMarkRead={(commentId) => markMentionsRead(projectId, readerUsername, [commentId])}
              onMarkUnread={(commentId) => markMentionsUnread(projectId, readerUsername, [commentId])}
              onDelete={dismissOne}
            />
          )}
        </PopoverContent>
      </Popover>

      {pendingDelete && (
        <Dialog open onOpenChange={(next) => { if (!next) closeDeleteDialog() }}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{deleteCopy.title}</DialogTitle>
              <DialogDescription>{deleteCopy.description}</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={closeDeleteDialog}>
                {t("common.cancel")}
              </Button>
              <Button type="button" variant="destructive" onClick={confirmDelete}>
                {t("common.delete")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  )
}

function NotificationList({
  label,
  notices,
  readIds,
  files,
  cellTextById,
  firstNoticeRef,
  markReadLabel,
  markUnreadLabel,
  deleteLabel,
  t,
  onOpen,
  onMarkRead,
  onMarkUnread,
  onDelete,
}: {
  label: string
  notices: MentionNotice[]
  readIds: ReadonlySet<string>
  files: readonly { id: string; name: string }[]
  cellTextById: ReadonlyMap<string, string> | undefined
  firstNoticeRef: Ref<HTMLButtonElement>
  markReadLabel: string
  markUnreadLabel: string
  deleteLabel: string
  t: TFunction
  onOpen: (notice: MentionNotice) => void
  onMarkRead: (commentId: string) => void
  onMarkUnread: (commentId: string) => void
  onDelete: (commentId: string) => void
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const pendingFocus = useRef<number | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)
  const virtualizer = useVirtualizer({
    count: notices.length,
    getScrollElement: () => scrollRef.current,
    getItemKey: (index) => notices[index]?.commentId ?? index,
    estimateSize: () => NOTICE_ROW_PX,
    overscan: 8,
    initialRect: { width: 420, height: 360 },
    // happy-dom reports 0×0 for CSS-sized scrollports; coerce so rows mount.
    observeElementRect: (instance, cb) =>
      observeElementRect(instance, (rect) => {
        cb({
          width: rect.width > 0 ? rect.width : 420,
          height: rect.height > 0 ? rect.height : 360,
        })
      }),
  })

  const handleScrollRef = useCallback(
    (element: HTMLDivElement | null) => {
      scrollRef.current = element
      if (element) virtualizer.measure()
    },
    [virtualizer],
  )

  const focusRow = useCallback((index: number) => {
    scrollRef.current
      ?.querySelector<HTMLButtonElement>(`[data-notice-index="${index}"]`)
      ?.focus()
  }, [])

  useEffect(() => {
    const index = pendingFocus.current
    if (index == null) return
    const button = scrollRef.current?.querySelector<HTMLButtonElement>(
      `[data-notice-index="${index}"]`,
    )
    if (!button) return
    button.focus()
    pendingFocus.current = null
  })

  function focusIndex(index: number) {
    const count = notices.length
    const next = ((index % count) + count) % count
    setActiveIndex(next)
    pendingFocus.current = next
    const isStart = next === 0
    const isEnd = next === count - 1
    // In-window rows are already painted. Scroll when the destination is an
    // edge the current window does not contain, the same rule as the chapter
    // picker: the virtualizer follows the highlight, it does not own the keys.
    const visible = scrollRef.current?.querySelector(`[data-notice-index="${next}"]`)
    if (!visible || isStart || isEnd) {
      virtualizer.scrollToIndex(next, { align: isEnd ? "end" : "start" })
    }
    focusRow(next)
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    if (notices.length === 0) return
    const range = virtualizer.range
    const page = Math.max(1, range ? range.endIndex - range.startIndex : 1)
    let next: number | null = null
    if (event.key === "ArrowDown") next = activeIndex + 1
    else if (event.key === "ArrowUp") next = activeIndex - 1
    else if (event.key === "Home") next = 0
    else if (event.key === "End") next = notices.length - 1
    else if (event.key === "PageDown") next = Math.min(notices.length - 1, activeIndex + page)
    else if (event.key === "PageUp") next = Math.max(0, activeIndex - page)
    else return
    event.preventDefault()
    focusIndex(next)
  }

  return (
    <div
      ref={handleScrollRef}
      aria-label={label}
      onKeyDown={onKeyDown}
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain scrollbar-thin pr-2 pb-2"
    >
      <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((virtualItem) => {
          const notice = notices[virtualItem.index]
          if (!notice) return null
          const place = placeLabel(notice, files, cellTextById, t)
          return (
            <div
              key={virtualItem.key}
              data-index={virtualItem.index}
              className="absolute top-0 left-0 w-full"
              style={{
                height: virtualItem.size,
                transform: `translateY(${virtualItem.start}px)`,
              }}
            >
              <NotificationRow
                notice={notice}
                isUnread={!readIds.has(notice.commentId)}
                index={virtualItem.index}
                setSize={notices.length}
                active={virtualItem.index === activeIndex}
                buttonRef={virtualItem.index === 0 ? firstNoticeRef : undefined}
                title={place || notice.authorLabel}
                timeLabel={formatRelativeTime(notice.createdAt, t)}
                subtitle={t("comments.inbox.commented", {
                  author: notice.authorLabel,
                  excerpt: notice.excerpt,
                })}
                markReadLabel={markReadLabel}
                markUnreadLabel={markUnreadLabel}
                deleteLabel={deleteLabel}
                onOpen={() => onOpen(notice)}
                onMarkRead={() => onMarkRead(notice.commentId)}
                onMarkUnread={() => onMarkUnread(notice.commentId)}
                onDelete={() => onDelete(notice.commentId)}
                onFocus={() => setActiveIndex(virtualItem.index)}
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}

function NotificationRow({
  notice,
  isUnread,
  index,
  setSize,
  active,
  buttonRef,
  title,
  timeLabel,
  subtitle,
  markReadLabel,
  markUnreadLabel,
  deleteLabel,
  onOpen,
  onMarkRead,
  onMarkUnread,
  onDelete,
  onFocus,
}: {
  notice: MentionNotice
  isUnread: boolean
  index: number
  setSize: number
  active: boolean
  buttonRef?: Ref<HTMLButtonElement>
  title: string
  timeLabel: string
  subtitle: string
  markReadLabel: string
  markUnreadLabel: string
  deleteLabel: string
  onOpen: () => void
  onMarkRead: () => void
  onMarkUnread: () => void
  onDelete: () => void
  onFocus: () => void
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={
          <button
            type="button"
            ref={buttonRef}
            tabIndex={active ? 0 : -1}
            data-notice-index={index}
            aria-setsize={setSize}
            aria-posinset={index + 1}
            onClick={onOpen}
            onFocus={onFocus}
            data-active={active || undefined}
            className="flex h-full w-full cursor-default items-center gap-2 rounded-md px-2 py-1 text-start outline-hidden select-none hover:bg-accent/40 focus-visible:bg-accent focus-visible:text-accent-foreground data-[active=true]:bg-accent data-[active=true]:text-accent-foreground data-[active=true]:hover:bg-accent"
          />
        }
      >
        <span aria-hidden className="shrink-0">
          <InitialsAvatar name={notice.authorId} size="sm" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline justify-between gap-3">
            <span className="flex min-w-0 items-center gap-1.5">
              {isUnread && (
                <span
                  aria-hidden
                  data-testid="notification-unread-dot"
                  className="size-1.5 shrink-0 rounded-full bg-primary"
                />
              )}
              <span className={cn("truncate text-sm font-medium", isUnread ? "text-foreground" : "text-foreground/90")} data-ph-mask>
                {title}
              </span>
            </span>
            <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
              {timeLabel}
            </span>
          </span>
          <span className="mt-0.5 block truncate text-xs text-muted-foreground" data-ph-mask>
            {subtitle}
          </span>
        </span>
      </ContextMenuTrigger>
      <ContextMenuContent className="min-w-44">
        {isUnread ? (
          <MenuItem onClick={onMarkRead}>
            <MailCheck />
            {markReadLabel}
          </MenuItem>
        ) : (
          <MenuItem onClick={onMarkUnread}>
            <MailBadge />
            {markUnreadLabel}
          </MenuItem>
        )}
        <MenuSeparator />
        <MenuItem onClick={onDelete}>
          <MailX />
          {deleteLabel}
        </MenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

function placeLabel(
  notice: MentionNotice,
  files: readonly { id: string; name: string }[],
  cellTextById: ReadonlyMap<string, string> | undefined,
  t: TFunction,
): string | null {
  if (notice.scopeKind === "cell") {
    // A verse or chapter address names the cell. Otherwise show its text.
    if (notice.cellRef) return notice.cellRef
    const live = notice.cellId ? cellTextById?.get(notice.cellId) : undefined
    return cellTextSnippet(live) ?? notice.cellText
  }
  if (notice.scopeKind === "file") {
    const fileName = notice.fileId ? files.find((file) => file.id === notice.fileId)?.name : undefined
    return fileName ? t("comments.scope.file", { file: fileName }) : null
  }
  return t("common.project")
}

function formatRelativeTime(timestamp: number, t: TFunction): string {
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000))
  if (seconds < 5) return t("nav.outbox.timeJustNow")
  if (seconds < 60) return t("nav.outbox.timeSecondsAgo", { sec: seconds })
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return t("nav.outbox.timeMinutesAgo", { min: minutes })
  const hours = Math.round(minutes / 60)
  if (hours < 24) return t("nav.outbox.timeHoursAgo", { hr: hours })
  const days = Math.round(hours / 24)
  return t("nav.outbox.timeDaysAgo", { d: days })
}
