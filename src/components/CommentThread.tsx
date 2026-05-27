import { useState } from "react"
import { Check, Undo2, Send, AlertTriangle } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { CommentThread as ThreadData } from "@/lib/parsers/types"
import { renderCommentHtml } from "@/lib/comments/comment-helpers"
import DOMPurify from "dompurify"
import { cn } from "@/lib/utils"

interface CommentThreadProps {
  thread: ThreadData
  currentTranslated: string
  canReply?: boolean
  canResolve?: boolean
  onReply: (text: string) => void
  onResolve: (closingMessage?: string) => void
  onReopen: () => void
}

export function CommentThread({ thread, currentTranslated, canReply = true, canResolve = true, onReply, onResolve, onReopen }: CommentThreadProps) {
  const [replyText, setReplyText] = useState("")
  const isStale = thread.createdForTranslated !== currentTranslated

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
        "neu-flat rounded-lg p-2 text-sm",
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
          {thread.status}
        </span>
        {isStale && (
          <span className="flex items-center gap-0.5 text-amber-500" title="Translation changed since this thread was created">
            <AlertTriangle className="h-3 w-3" /> stale
          </span>
        )}
        <span className="text-muted-foreground">{formatTimestamp(thread.createdAt)}</span>
      </div>

      <ul className="space-y-2">
        {thread.messages.map((m) => (
          <li key={m.id} className="neu-inset rounded-lg p-2">
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
              <textarea
                value={replyText}
                onChange={(e) => setReplyText(e.target.value)}
                placeholder="Reply..."
                rows={2}
                className="neu-inset w-full resize-none rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
              />
            )}
            <div className="flex flex-wrap gap-1">
              {canReply && (
                <Button size="sm" variant="outline" onClick={handleReply} disabled={!replyText.trim()}>
                  <Send className="mr-1 h-3 w-3" /> Reply
                </Button>
              )}
              {canReply && canResolve && (
                <Button size="sm" variant="outline" onClick={handleCloseWithReply} disabled={!replyText.trim()}>
                  <Check className="mr-1 h-3 w-3" /> Close with reply
                </Button>
              )}
              {canResolve && (
                <Button size="sm" variant="ghost" onClick={() => onResolve()}>
                  Resolve
                </Button>
              )}
            </div>
          </div>
        )
      ) : (
        canResolve && (
          <div className="mt-2">
            <Button size="sm" variant="ghost" onClick={onReopen}>
              <Undo2 className="mr-1 h-3 w-3" /> Reopen
            </Button>
          </div>
        )
      )}
    </div>
  )
}
