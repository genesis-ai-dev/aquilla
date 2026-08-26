import { useState, useEffect } from "react"
import { Check, Undo2, Send, AlertTriangle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { AppTooltip } from "@/components/ui/tooltip"
import type { CommentThread as ThreadData } from "@/lib/parsers/types"
import { renderCommentHtml, isThreadStale } from "@/lib/comments/comment-helpers"
import DOMPurify from "dompurify"
import { cn } from "@/lib/utils"
import { useI18n } from "@/lib/i18n/I18nProvider"
import { DateTooltip } from "@/components/ui/date-tooltip"
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
  projectId?: string
  cellId?: string
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

interface ResolveActionProps {
  denied: boolean
  reason?: string | null
  size: "sm"
  variant: "outline" | "ghost"
  testId: string
  onClick: () => void
  disabled?: boolean
  children: React.ReactNode
}

/**
 * AQU-1000: one resolve-family control (Resolve / Close with reply / Reopen).
 *
 * When `denied`, it stays on screen but inert, wrapped in the tooltip that
 * says why — the alternative, letting the user press a button the server was
 * always going to refuse, is what produced the flip-then-revert. `aria-disabled`
 * rather than `disabled` keeps the button focusable so the explanation is
 * reachable by keyboard and screen reader, per `09-design-and-ux.md` →
 * "Never disable silently".
 */
function ResolveAction({ denied, reason, size, variant, testId, onClick, disabled, children }: ResolveActionProps) {
  const button = (
    <Button
      size={size}
      variant={variant}
      data-testid={testId}
      aria-disabled={denied || undefined}
      className={cn(denied && "cursor-not-allowed opacity-50")}
      onClick={denied ? undefined : onClick}
      disabled={!denied && disabled}
    >
      {children}
    </Button>
  )
  if (!denied) return button
  return <AppTooltip content={reason ?? ""}>{button}</AppTooltip>
}

export function CommentThread({ thread, currentTranslated, canReply = true, canResolve = true, resolveDenialReason, onReply, onResolve, onReopen, projectId, cellId }: CommentThreadProps) {
  const { t } = useI18n()
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
  const isStale = isThreadStale(thread.createdForTranslated, currentTranslated)

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

  function handleReplyKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault()
      handleReply()
    }
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

  return (
    <div
      className={cn(
        "bg-card rounded-lg p-2 text-sm",
        thread.status === "resolved" && "opacity-60"
      )}
    >
      <div className="mb-1 flex items-center gap-1.5 text-xs">
        <span
          className={cn(
            "rounded px-1.5 py-0.5 font-medium",
            thread.status === "open"
              ? "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-400"
              : "bg-muted text-muted-foreground"
          )}
        >
          {thread.status === "open" ? t("comments.status.open") : t("comments.status.resolved")}
        </span>
        {isStale && (
          <AppTooltip content={t("comments.stale.tooltip")}>
            <span className="flex items-center gap-0.5 text-amber-500">
              <AlertTriangle className="h-3 w-3" /> {t("comments.stale.badge")}
            </span>
          </AppTooltip>
        )}
        <span className="text-muted-foreground">
          <DateTooltip value={thread.createdAt} label={t("common.date.posted")} />
        </span>
      </div>

      <ul className="space-y-2">
        {thread.messages.map((m) => (
          <li key={m.id} className="bg-muted rounded-lg p-2">
            <div className="flex items-baseline gap-1.5 text-xs">
              <span className="font-medium">{m.author}</span>
              <span className="text-muted-foreground">
                <DateTooltip value={m.timestamp} label={t("common.date.posted")} />
              </span>
            </div>
            <div
              className="mt-0.5 text-xs"
              // Session-replay mask (docs/OPSEC.md): comment bodies quote
              // draft text and name collaborators.
              data-ph-mask=""
              dangerouslySetInnerHTML={{ __html: safeCommentHtml(m.text) }}
            />
          </li>
        ))}
      </ul>

      {thread.status === "open" ? (
        (canReply || canResolve || showResolveDenied) && (
          <div className="mt-2 space-y-1.5">
            {canReply && (
              <Textarea
                value={replyText}
                onChange={(e) => setReplyText(e.target.value)}
                onKeyDown={handleReplyKeyDown}
                placeholder={t("comments.thread.replyPlaceholder")}
                rows={2}
                className="resize-none"
              />
            )}
            <div className="flex flex-wrap gap-1">
              {canReply && (
                <Button size="sm" variant="outline" onClick={handleReply} disabled={!replyText.trim()}>
                  <Send className="me-1 h-3 w-3" /> {t("comments.thread.reply")}
                </Button>
              )}
              {canReply && (canResolve || showResolveDenied) && (
                <ResolveAction
                  denied={showResolveDenied}
                  reason={resolveDenialReason}
                  size="sm"
                  variant="outline"
                  testId="comment-close-with-reply"
                  onClick={handleCloseWithReply}
                  disabled={!replyText.trim()}
                >
                  <Check className="me-1 h-3 w-3" /> {t("comments.thread.closeWithReply")}
                </ResolveAction>
              )}
              {(canResolve || showResolveDenied) && (
                <ResolveAction
                  denied={showResolveDenied}
                  reason={resolveDenialReason}
                  size="sm"
                  variant="ghost"
                  testId="comment-resolve"
                  onClick={() => onResolve()}
                >
                  {t("comments.resolve")}
                </ResolveAction>
              )}
            </div>
          </div>
        )
      ) : (
        (canResolve || showResolveDenied) && (
          <div className="mt-2">
            <ResolveAction
              denied={showResolveDenied}
              reason={resolveDenialReason}
              size="sm"
              variant="ghost"
              testId="comment-reopen"
              onClick={onReopen}
            >
              <Undo2 className="me-1 h-3 w-3" /> {t("comments.reopen")}
            </ResolveAction>
          </div>
        )
      )}
    </div>
  )
}
