import { useMemo, useState } from "react"
import { Bell } from "lucide-react"
import { useNavigate } from "react-router-dom"
import { InitialsAvatar } from "@/components/InitialsAvatar"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"
import { useT, type TFunction } from "@/lib/i18n/I18nProvider"
import { cellTextSnippet, mentionNoticesFor, type MentionNotice } from "@/lib/comments/mention-inbox"
import { markMentionsRead, useMentionReadIds } from "@/lib/store/mention-read-state"
import { editorCommentHref } from "@/components/project-workspace-lane-deeplink"
import type { CommentRecord } from "@/lib/sync/comments-read-types"

const VISIBLE_NOTICES = 40

/**
 * In-app inbox for comment @mentions (AQU-761). Derived from comments already
 * loaded for the open project — there is no notification table. Read state
 * lives on this device. Rows follow a compact inbox: an unread dot, the
 * cell (verse, chapter, or its text) as the title, the comment under it,
 * and the time on the right.
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
  const readIds = useMentionReadIds(projectId, readerUsername)
  const notices = useMemo(
    () => mentionNoticesFor(comments, readerUsername),
    [comments, readerUsername],
  )
  const unread = notices.filter((notice) => !readIds.has(notice.commentId))
  const shown = [...unread, ...notices.filter((notice) => readIds.has(notice.commentId))].slice(
    0,
    VISIBLE_NOTICES,
  )

  function openNotice(notice: MentionNotice) {
    markMentionsRead(projectId, readerUsername, [notice.commentId])
    setOpen(false)
    if (notice.scopeKind === "cell" && notice.fileId && notice.cellId) {
      navigate(editorCommentHref(projectId, notice.fileId, notice.cellId, notice.commentId))
      return
    }
    navigate(`/project/${projectId}/comments`)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
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
          {unread.length > 0 && (
            <button
              type="button"
              onClick={() =>
                markMentionsRead(
                  projectId,
                  readerUsername,
                  notices.map((notice) => notice.commentId),
                )
              }
              className="rounded-md px-1.5 py-0.5 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {t("comments.inbox.markAllRead")}
            </button>
          )}
        </header>

        {shown.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 px-3 py-10 text-center">
            <span className="flex size-9 items-center justify-center rounded-lg bg-muted text-muted-foreground">
              <Bell className="size-4" aria-hidden />
            </span>
            <p className="text-sm font-medium">{t("comments.inbox.emptyTitle")}</p>
            <p className="text-xs text-muted-foreground">{t("comments.inbox.empty")}</p>
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            <ul>
              {shown.map((notice) => {
                const isUnread = !readIds.has(notice.commentId)
                const place = placeLabel(notice, files, cellTextById, t)
                const title = place || notice.authorLabel
                return (
                  <li key={notice.commentId}>
                    <button
                      type="button"
                      onClick={() => openNotice(notice)}
                      className="flex w-full items-start gap-2.5 px-3 py-2 text-start transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                    >
                      <span aria-hidden className="mt-0.5 shrink-0">
                        <InitialsAvatar name={notice.authorId} size="sm" />
                      </span>
                      <span
                        aria-hidden
                        data-testid={isUnread ? "notification-unread-dot" : undefined}
                        className={cn(
                          "mt-1.5 size-1.5 shrink-0 rounded-full",
                          isUnread ? "bg-primary" : "bg-transparent",
                        )}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-baseline justify-between gap-3">
                          <span className={cn("truncate text-sm", isUnread ? "font-semibold" : "font-medium text-foreground/90")} data-ph-mask>
                            {title}
                          </span>
                          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                            {formatRelativeTime(notice.createdAt, t)}
                          </span>
                        </span>
                        <span className="mt-0.5 block truncate text-xs text-muted-foreground" data-ph-mask>
                          {place ? (
                            <>
                              <span>{notice.authorLabel}</span>
                              <span aria-hidden> · </span>
                              {notice.excerpt}
                            </>
                          ) : (
                            notice.excerpt
                          )}
                        </span>
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          </div>
        )}

      </PopoverContent>
    </Popover>
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
