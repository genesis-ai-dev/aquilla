import { useMemo, useRef, useState } from "react"
import { Bell, Check, ListFilter, MailCheck, MoreHorizontal, Trash2 } from "lucide-react"
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
import { cn } from "@/lib/utils"
import { useT, type TFunction } from "@/lib/i18n/I18nProvider"
import { cellTextSnippet, mentionNoticesFor, type MentionNotice } from "@/lib/comments/mention-inbox"
import {
  dismissMentions,
  markMentionsRead,
  useMentionDismissedIds,
  useMentionReadIds,
} from "@/lib/store/mention-read-state"
import { editorCommentHref } from "@/components/project-workspace-lane-deeplink"
import type { CommentRecord } from "@/lib/sync/comments-read-types"

const VISIBLE_NOTICES = 40

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
  const shown = (unreadsOnly ? unread : [...unread, ...read]).slice(0, VISIBLE_NOTICES)

  function openNotice(notice: MentionNotice) {
    markMentionsRead(projectId, readerUsername, [notice.commentId])
    setOpen(false)
    if (notice.scopeKind === "cell" && notice.fileId && notice.cellId) {
      navigate(editorCommentHref(projectId, notice.fileId, notice.cellId, notice.commentId))
      return
    }
    navigate(`/project/${projectId}/comments`)
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
          className="flex max-h-[min(560px,calc(100vh-6rem))] w-[420px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden p-0"
        >
          <header className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-2">
            <h3 className="text-sm font-semibold tracking-tight">{t("comments.inbox.title")}</h3>
            {notices.length > 0 && (
              <div className="flex items-center gap-0.5">
                <AppTooltip content={t("comments.inbox.unreadsOnly")}>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-pressed={unreadsOnly}
                    aria-label={t("comments.inbox.unreadsOnly")}
                    data-testid="notifications-unreads-only"
                    className={unreadsOnly ? "bg-accent text-foreground" : undefined}
                    onClick={() => setUnreadsOnly((value) => !value)}
                  >
                    <ListFilter />
                  </Button>
                </AppTooltip>
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
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
                      <Trash2 />
                      {t("comments.inbox.deleteAll")}
                    </MenuItem>
                    <MenuItem disabled={read.length === 0} onClick={() => askDelete({ kind: "read" })}>
                      <Trash2 />
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
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
              <ul>
                {shown.map((notice) => {
                  const isUnread = !readIds.has(notice.commentId)
                  const place = placeLabel(notice, files, cellTextById, t)
                  return (
                    <li key={notice.commentId}>
                      <NotificationRow
                        notice={notice}
                        isUnread={isUnread}
                        title={place || notice.authorLabel}
                        timeLabel={formatRelativeTime(notice.createdAt, t)}
                        subtitle={t("comments.inbox.commented", {
                          author: notice.authorLabel,
                          excerpt: notice.excerpt,
                        })}
                        markReadLabel={t("comments.inbox.markRead")}
                        deleteLabel={t("common.delete")}
                        onOpen={() => openNotice(notice)}
                        onMarkRead={() => markMentionsRead(projectId, readerUsername, [notice.commentId])}
                        onDelete={() => askDelete({ kind: "one", commentId: notice.commentId })}
                      />
                    </li>
                  )
                })}
              </ul>
            </div>
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

function NotificationRow({
  notice,
  isUnread,
  title,
  timeLabel,
  subtitle,
  markReadLabel,
  deleteLabel,
  onOpen,
  onMarkRead,
  onDelete,
}: {
  notice: MentionNotice
  isUnread: boolean
  title: string
  timeLabel: string
  subtitle: string
  markReadLabel: string
  deleteLabel: string
  onOpen: () => void
  onMarkRead: () => void
  onDelete: () => void
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={
          <button
            type="button"
            onClick={onOpen}
            className="flex w-full items-start gap-2.5 px-3 py-2 text-start transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          />
        }
      >
        <span aria-hidden className="mt-0.5 shrink-0">
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
              <span className={cn("truncate text-sm", isUnread ? "font-semibold" : "font-medium text-foreground/90")} data-ph-mask>
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
        {isUnread && (
          <MenuItem onClick={onMarkRead}>
            <Check />
            {markReadLabel}
          </MenuItem>
        )}
        {isUnread && <MenuSeparator />}
        <MenuItem onClick={onDelete}>
          <Trash2 />
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
