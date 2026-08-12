import { useState, useEffect } from "react"
import { Check, Undo2, Send, AlertTriangle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { AppTooltip } from "@/components/ui/tooltip"
import type { CommentThread as ThreadData } from "@/lib/parsers/types"
import { renderCommentHtml, isThreadStale } from "@/lib/comments/comment-helpers"
import DOMPurify from "dompurify"
import { cn } from "@/lib/utils"
import { useT } from "@/lib/i18n/I18nProvider"

interface CommentThreadProps {
  thread: ThreadData
  currentTranslated: string
  canReply?: boolean
  canResolve?: boolean
  onReply: (text: string) => void
  onResolve: (closingMessage?: string) => void
  onReopen: () => void
  projectId?: string
  cellId?: string
}

function draftKey(projectId: string | undefined, cellId: string | undefined, threadId: string): string {
  return `comment-draft:${projectId ?? "unknown"}:${cellId ?? "unknown"}:${threadId}`
}

export function CommentThread({ thread, currentTranslated, canReply = true, canResolve = true, onReply, onResolve, onReopen, projectId, cellId }: CommentThreadProps) {
  const t = useT()
  const storageKey = draftKey(projectId, cellId, thread.id)
  const [replyText, setReplyText] = useState(() => {
    if (typeof window === "undefined") return ""
    try { return localStorage.getItem(storageKey) ?? "" } catch { return "" }
  })
  const isStale = isThreadStale(thread.createdForTranslated, currentTranslated)

  // Persist draft to localStorage whenever it changes
  useEffect(() => {
    if (typeof window === "undefined") return
    try {
      if (replyText) {
        localStorage.setItem(storageKey, replyText)
      } else {
        localStorage.removeItem(storageKey)
      }
    } catch { /* ignore quota errors */ }
  }, [replyText, storageKey])

  function formatTimestamp(iso: string): string {
    try {
      return new Date(iso).toLocaleString()
    } catch {
      return iso
    }
  }

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
        <span className="text-muted-foreground">{formatTimestamp(thread.createdAt)}</span>
      </div>

      <ul className="space-y-2">
        {thread.messages.map((m) => (
          <li key={m.id} className="bg-muted rounded-lg p-2">
            <div className="flex items-baseline gap-1.5 text-xs">
              <span className="font-medium">{m.author}</span>
              <span className="text-muted-foreground">{formatTimestamp(m.timestamp)}</span>
            </div>
            {/* eslint-disable-next-line react/no-danger */}
            <div
              className="mt-0.5 text-xs"
              dangerouslySetInnerHTML={{ __html: safeCommentHtml(m.text) }}
            />
          </li>
        ))}
      </ul>

      {thread.status === "open" ? (
        (canReply || canResolve) && (
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
              {canReply && canResolve && (
                <Button size="sm" variant="outline" onClick={handleCloseWithReply} disabled={!replyText.trim()}>
                  <Check className="me-1 h-3 w-3" /> {t("comments.thread.closeWithReply")}
                </Button>
              )}
              {canResolve && (
                <Button size="sm" variant="ghost" onClick={() => onResolve()}>
                  {t("comments.resolve")}
                </Button>
              )}
            </div>
          </div>
        )
      ) : (
        canResolve && (
          <div className="mt-2">
            <Button size="sm" variant="ghost" onClick={onReopen}>
              <Undo2 className="me-1 h-3 w-3" /> {t("comments.reopen")}
            </Button>
          </div>
        )
      )}
    </div>
  )
}
