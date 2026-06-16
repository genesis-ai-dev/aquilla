/**
 * ChatMessageBubble.tsx — chat UX improvements
 *
 * Shared message bubble for the chat sheet and dock panels.
 *  - Assistant messages render markdown; user messages stay plain text.
 *  - Hover/focus action toolbar: copy, insert-into-cell, regenerate.
 *  - Failed user messages show muted styling + error line with Retry/Dismiss.
 *  - Relative timestamp (legacy messages without `ts` render nothing).
 */

import { useState } from "react"
import { Copy, Check, RefreshCw, ArrowDownToLine, RotateCw, X } from "lucide-react"
import { cn } from "@/lib/utils"
import { formatRelativeTime } from "@/lib/time/relative"
import type { UiChatMessage } from "@/hooks/useChat"
import { ChatMarkdown } from "./ChatMarkdown"
import { AppTooltip } from "@/components/ui/tooltip"

export interface ChatMessageBubbleProps {
  message: UiChatMessage
  compact?: boolean
  /** True for the in-flight assistant bubble (renders the pulse caret). */
  isStreaming?: boolean
  /** Show "Insert into cell" — only when a cell is focused. */
  canInsertIntoCell?: boolean
  onInsertIntoCell?: (message: UiChatMessage) => void
  /** Set only on the last assistant message. */
  onRegenerate?: () => void
  onRetry?: (message: UiChatMessage) => void
  onDismiss?: (message: UiChatMessage) => void
}

function ActionButton({
  title,
  onClick,
  children,
}: {
  title: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <AppTooltip content={title}>
      <button
        type="button"
        aria-label={title}
        onClick={onClick}
        className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        {children}
      </button>
    </AppTooltip>
  )
}

export function ChatMessageBubble({
  message,
  compact,
  isStreaming,
  canInsertIntoCell,
  onInsertIntoCell,
  onRegenerate,
  onRetry,
  onDismiss,
}: ChatMessageBubbleProps) {
  const isUser = message.role === "user"
  const isFailed = message.status === "failed"
  const [copied, setCopied] = useState(false)

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(message.content)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard unavailable — nothing to surface here.
    }
  }

  const relTime = message.ts ? formatRelativeTime(new Date(message.ts).toISOString()) : null
  const iconCls = compact ? "h-3 w-3" : "h-3.5 w-3.5"
  const showActions = !isUser && !isStreaming

  return (
    <div className={cn("group/msg flex flex-col", isUser ? "items-end" : "items-start")}>
      <div
        className={cn(
          "max-w-[85%] rounded-xl",
          compact ? "px-2.5 py-1.5 text-xs" : "px-3 py-2 text-sm",
          isUser ? "bg-primary text-primary-foreground" : "bg-muted text-foreground",
          isFailed && "opacity-60",
        )}
      >
        {isUser ? (
          <pre className={cn("whitespace-pre-wrap font-sans leading-relaxed", compact ? "text-xs" : "text-sm")}>
            {message.content}
          </pre>
        ) : (
          <div>
            {message.content ? <ChatMarkdown content={message.content} /> : isStreaming ? null : "…"}
            {isStreaming && (
              <span
                aria-hidden
                className="ml-0.5 inline-block h-3.5 w-0.5 animate-pulse bg-current align-middle"
              />
            )}
          </div>
        )}
      </div>

      {/* Failed send: error line + Retry / Dismiss */}
      {isFailed && (
        <div className={cn("mt-1 flex max-w-[85%] flex-col gap-0.5", compact ? "text-[10px]" : "text-xs")}>
          <div className="flex items-center gap-2 text-destructive">
            <span>{message.errorMessage ?? "Something went wrong."}</span>
            <button
              type="button"
              onClick={() => onRetry?.(message)}
              className="flex items-center gap-0.5 rounded px-1 py-0.5 font-medium hover:bg-destructive/10"
            >
              <RotateCw className="h-3 w-3" />
              Retry
            </button>
            <button
              type="button"
              onClick={() => onDismiss?.(message)}
              className="flex items-center gap-0.5 rounded px-1 py-0.5 text-muted-foreground hover:bg-accent"
            >
              <X className="h-3 w-3" />
              Dismiss
            </button>
          </div>
          {message.errorDetail && message.errorDetail !== message.errorMessage && (
            <details className="text-muted-foreground">
              <summary className="cursor-pointer select-none">Details</summary>
              <span className="break-all">{message.errorDetail}</span>
            </details>
          )}
        </div>
      )}

      {/* Hover toolbar (assistant messages) + relative timestamp */}
      {!isFailed && (
        <div
          className={cn(
            "mt-0.5 flex h-5 items-center gap-0.5 opacity-0 transition-opacity",
            "group-hover/msg:opacity-100 focus-within:opacity-100",
          )}
        >
          {showActions && (
            <>
              <ActionButton title={copied ? "Copied" : "Copy"} onClick={() => void handleCopy()}>
                {copied ? <Check className={iconCls} /> : <Copy className={iconCls} />}
              </ActionButton>
              {canInsertIntoCell && onInsertIntoCell && (
                <ActionButton title="Insert into cell" onClick={() => onInsertIntoCell(message)}>
                  <ArrowDownToLine className={iconCls} />
                </ActionButton>
              )}
              {onRegenerate && (
                <ActionButton title="Regenerate" onClick={onRegenerate}>
                  <RefreshCw className={iconCls} />
                </ActionButton>
              )}
            </>
          )}
          {relTime && (
            <span className={cn("px-1 text-muted-foreground", compact ? "text-[9px]" : "text-[10px]")}>
              {relTime}
            </span>
          )}
        </div>
      )}
    </div>
  )
}
