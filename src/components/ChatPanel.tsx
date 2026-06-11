/**
 * ChatPanel.tsx — FRO-175
 *
 * Right-side chat drawer for the workspace AI copilot.
 *
 * Features:
 *  - Composer + streamed assistant responses
 *  - Conversation history within the session
 *  - Toggle to include the current cell (and its translation) as context
 *  - Uses the configured LLM endpoint (Aquilla default / OpenAI-compatible / local)
 *
 * UI: shadcn Sheet + base-nova primitives, lucide icons, no toast lib.
 */

import { useRef, useEffect, useState, type KeyboardEvent } from "react"
import { MessageSquare, X, Trash2, Square, Pin, PinOff } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { cn } from "@/lib/utils"
import { cellTextForDisplay, truncateCellText } from "@/lib/cell-text"
import type { UseChatReturn, CellContext } from "@/hooks/useChat"

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface ChatPanelProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  chat: UseChatReturn
  /** The currently focused cell; wired in ProjectWorkspace via focusedCellIdRef */
  currentCell: CellContext | null
}

// ---------------------------------------------------------------------------
// Main panel
// ---------------------------------------------------------------------------

export function ChatPanel({ open, onOpenChange, chat, currentCell }: ChatPanelProps) {
  const {
    messages,
    streamingText,
    isStreaming,
    error,
    includeCellContext,
    setIncludeCellContext,
    isConfigured,
    sendMessage,
    stopStreaming,
    clearHistory,
  } = chat

  const [draft, setDraft] = useState("")
  const bottomRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Auto-scroll to the bottom when new content arrives.
  useEffect(() => {
    if (open) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" })
    }
  }, [messages, streamingText, open])

  // Focus the textarea when the panel opens.
  useEffect(() => {
    if (open) {
      setTimeout(() => textareaRef.current?.focus(), 50)
    }
  }, [open])

  function handleSend() {
    if (!draft.trim() || isStreaming) return
    const text = draft
    setDraft("")
    void sendMessage(text, currentCell)
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault()
      handleSend()
    }
  }

  const hasHistory = messages.length > 0 || isStreaming

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="flex w-96 max-w-full flex-col p-0"
        showCloseButton={false}
      >
        {/* Header */}
        <SheetHeader className="flex-row items-center justify-between border-b px-4 py-3">
          <div className="flex items-center gap-2">
            <MessageSquare className="h-4 w-4 text-muted-foreground" />
            <SheetTitle className="text-sm">AI Chat</SheetTitle>
          </div>
          <div className="flex items-center gap-1">
            {hasHistory && (
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={clearHistory}
                title="Clear conversation"
                aria-label="Clear conversation"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => onOpenChange(false)}
              aria-label="Close chat"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </SheetHeader>

        {/* Context toggle strip */}
        <div className="flex items-center gap-2 border-b bg-muted/40 px-4 py-2">
          <button
            type="button"
            onClick={() => setIncludeCellContext(!includeCellContext)}
            className={cn(
              "flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] transition-colors",
              includeCellContext && currentCell
                ? "bg-primary/10 text-primary"
                : "text-muted-foreground hover:bg-accent",
            )}
            title={
              includeCellContext
                ? "Cell context is included — click to exclude"
                : "Click to include the current cell as context"
            }
          >
            {includeCellContext ? (
              <Pin className="h-3 w-3" />
            ) : (
              <PinOff className="h-3 w-3" />
            )}
            {includeCellContext && currentCell
              ? currentCell.context
                ? `Cell: ${currentCell.context}`
                : "Cell context on"
              : "No cell context"}
          </button>
          {includeCellContext && currentCell && (() => {
            const preview =
              cellTextForDisplay(currentCell.sourceText) ||
              cellTextForDisplay(currentCell.translatedText)
            if (!preview) return null
            return (
              <span className="truncate text-[11px] text-muted-foreground" title={preview}>
                {truncateCellText(preview, 40)}
              </span>
            )
          })()}
        </div>

        {/* Message list */}
        <div className="flex-1 overflow-y-auto">
          {!isConfigured && messages.length === 0 && !isStreaming && (
            <div className="p-4 text-sm text-muted-foreground">
              Configure an AI provider in project settings to start chatting.
            </div>
          )}

          {messages.length === 0 && !isStreaming && isConfigured && (
            <div className="p-4 text-sm text-muted-foreground">
              Ask anything about the current passage, source meaning, or translation strategy.
              {includeCellContext && currentCell && (
                <span className="block mt-1 text-xs">
                  The current cell will be included as context.
                </span>
              )}
            </div>
          )}

          <div className="flex flex-col gap-3 px-4 py-3">
            {messages.map((msg, i) => (
              <ChatBubble key={i} role={msg.role} content={msg.content} />
            ))}

            {/* Streaming in-progress reply */}
            {isStreaming && (
              <ChatBubble role="assistant" content={streamingText} isStreaming />
            )}
          </div>

          <div ref={bottomRef} />
        </div>

        {/* Error banner */}
        {error && (
          <div className="border-t bg-destructive/10 px-4 py-2 text-xs text-destructive">
            {error}
          </div>
        )}

        {/* Composer */}
        <div className="border-t p-3">
          <div className="flex flex-col gap-2">
            <textarea
              ref={textareaRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask a question… (⌘↵ to send)"
              rows={3}
              disabled={isStreaming || !isConfigured}
              className={cn(
                "w-full resize-none rounded-md border bg-background px-3 py-2 text-sm",
                "placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring",
                "disabled:opacity-50",
              )}
            />
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-muted-foreground">⌘↵ to send</span>
              <div className="flex items-center gap-1.5">
                {isStreaming && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={stopStreaming}
                    className="h-7 gap-1 text-xs"
                  >
                    <Square className="h-3 w-3" />
                    Stop
                  </Button>
                )}
                <Button
                  size="sm"
                  onClick={handleSend}
                  disabled={!draft.trim() || isStreaming || !isConfigured}
                  className="h-7 text-xs"
                >
                  Send
                </Button>
              </div>
            </div>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  )
}

// ---------------------------------------------------------------------------
// ChatBubble
// ---------------------------------------------------------------------------

interface ChatBubbleProps {
  role: "user" | "assistant" | "system"
  content: string
  isStreaming?: boolean
}

function ChatBubble({ role, content, isStreaming }: ChatBubbleProps) {
  const isUser = role === "user"

  return (
    <div
      className={cn(
        "flex",
        isUser ? "justify-end" : "justify-start",
      )}
    >
      <div
        className={cn(
          "max-w-[85%] rounded-xl px-3 py-2 text-sm",
          isUser
            ? "bg-primary text-primary-foreground"
            : "bg-muted text-foreground",
        )}
      >
        {/* Simple whitespace-preserving render — no heavy markdown lib */}
        <pre
          className={cn(
            "whitespace-pre-wrap font-sans text-sm leading-relaxed",
            isStreaming && "after:ml-0.5 after:inline-block after:h-3.5 after:w-0.5 after:animate-pulse after:bg-current after:align-middle after:content-['']",
          )}
        >
          {content || (isStreaming ? "" : "…")}
        </pre>
      </div>
    </div>
  )
}
