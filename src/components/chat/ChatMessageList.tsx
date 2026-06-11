/**
 * ChatMessageList.tsx — chat UX improvements
 *
 * Shared scrollable message list for the chat sheet and dock panels.
 *  - Stick-to-bottom only while the user is at (or near) the bottom; a
 *    "Jump to latest" pill appears when new content arrives while scrolled up.
 *  - Owns the insert-into-cell confirm (shown when the cell has text).
 *  - Scrolls its own container only — never scrollIntoView, which walks
 *    ancestor scroll containers (the dock rail) and drifts chrome up.
 */

import { useEffect, useRef, useState, useCallback } from "react"
import { ArrowDown } from "lucide-react"
import { cn } from "@/lib/utils"
import type { UiChatMessage, CellContext } from "@/hooks/useChat"
import { ChatMessageBubble } from "./ChatMessageBubble"
import { ChatConfirmDialog } from "./ChatConfirmDialog"
import { markdownToPlainText } from "./markdown-plain"

const NEAR_BOTTOM_PX = 48

export interface ChatMessageListProps {
  messages: UiChatMessage[]
  streamingText: string
  isStreaming: boolean
  isConfigured: boolean
  includeCellContext: boolean
  currentCell: CellContext | null
  compact?: boolean
  /** Commit plain text into the focused cell (ProjectWorkspace wiring). */
  onInsertIntoCell?: (text: string) => void | Promise<void>
  onRegenerate?: () => void
  onRetry?: (message: UiChatMessage) => void
  onDismiss?: (message: UiChatMessage) => void
}

export function ChatMessageList({
  messages,
  streamingText,
  isStreaming,
  isConfigured,
  includeCellContext,
  currentCell,
  compact,
  onInsertIntoCell,
  onRegenerate,
  onRetry,
  onDismiss,
}: ChatMessageListProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const atBottomRef = useRef(true)
  const [showJump, setShowJump] = useState(false)
  const [pendingInsert, setPendingInsert] = useState<string | null>(null)

  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX
    atBottomRef.current = near
    if (near) setShowJump(false)
  }, [])

  // New content: follow only when already at the bottom; otherwise show pill.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    if (atBottomRef.current) {
      el.scrollTo({ top: el.scrollHeight, behavior: isStreaming ? "auto" : "smooth" })
    } else if (messages.length > 0 || streamingText) {
      setShowJump(true)
    }
  }, [messages, streamingText, isStreaming])

  const jumpToLatest = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    atBottomRef.current = true
    setShowJump(false)
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" })
  }, [])

  function handleInsertClick(message: UiChatMessage) {
    if (!onInsertIntoCell || !currentCell) return
    const plain = markdownToPlainText(message.content)
    if (!plain) return
    if (currentCell.translatedText.trim()) {
      setPendingInsert(plain)
    } else {
      void onInsertIntoCell(plain)
    }
  }

  // Regenerate applies to the last assistant message only.
  const lastMsg = messages[messages.length - 1]
  const lastAssistantId = !isStreaming && lastMsg?.role === "assistant" ? lastMsg.id : null

  const pad = compact ? "p-3 text-xs" : "p-4 text-sm"

  return (
    <div className="relative flex-1 overflow-hidden">
      <div ref={scrollRef} onScroll={handleScroll} className="h-full overflow-y-auto">
        {!isConfigured && messages.length === 0 && !isStreaming && (
          <div className={cn("text-muted-foreground", pad)}>
            Configure an AI provider in project settings to start chatting.
          </div>
        )}

        {messages.length === 0 && !isStreaming && isConfigured && (
          <div className={cn("text-muted-foreground", pad)}>
            Ask anything about the current passage, source meaning, or translation strategy.
            {includeCellContext && currentCell && (
              <span className={cn("mt-1 block", compact ? "text-[10px]" : "text-xs")}>
                The current cell will be included as context.
              </span>
            )}
          </div>
        )}

        <div className={cn("flex flex-col", compact ? "gap-2.5 px-3 py-2" : "gap-3 px-4 py-3")}>
          {messages.map((msg) => (
            <ChatMessageBubble
              key={msg.id}
              message={msg}
              compact={compact}
              canInsertIntoCell={Boolean(currentCell && onInsertIntoCell)}
              onInsertIntoCell={handleInsertClick}
              onRegenerate={msg.id === lastAssistantId && onRegenerate ? onRegenerate : undefined}
              onRetry={onRetry}
              onDismiss={onDismiss}
            />
          ))}

          {/* Streaming in-progress reply */}
          {isStreaming && (
            <ChatMessageBubble
              message={{ id: "streaming", role: "assistant", content: streamingText }}
              compact={compact}
              isStreaming
            />
          )}
        </div>
      </div>

      {/* Jump-to-latest pill */}
      {showJump && (
        <button
          type="button"
          onClick={jumpToLatest}
          className={cn(
            "absolute bottom-2 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full border",
            "bg-background px-2.5 py-1 text-muted-foreground shadow-sm transition-colors hover:text-foreground",
            compact ? "text-[10px]" : "text-xs",
          )}
        >
          <ArrowDown className="h-3 w-3" />
          Jump to latest
        </button>
      )}

      {/* Insert-into-cell overwrite confirm */}
      <ChatConfirmDialog
        open={pendingInsert !== null}
        title="Replace current translation?"
        description="The focused cell already has text. Inserting this reply replaces it. The current text is preserved in cell history and can be recovered."
        confirmLabel="Replace"
        variant="destructive"
        onConfirm={() => {
          if (pendingInsert && onInsertIntoCell) void onInsertIntoCell(pendingInsert)
          setPendingInsert(null)
        }}
        onCancel={() => setPendingInsert(null)}
      />
    </div>
  )
}
