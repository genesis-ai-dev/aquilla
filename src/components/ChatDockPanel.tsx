/**
 * ChatDockPanel.tsx — FRO-320
 *
 * Inline AI chat panel for the left dock.
 * Same chat logic as ChatPanel.tsx (Sheet variant) but rendered as a
 * flex-column panel rather than a Sheet overlay.
 *
 * Uses shadcn "base-nova" primitives (Button, cn) already in the project.
 * Does NOT change streaming / history internals (those belong to FRO-303).
 */

import { useRef, useEffect, useState, type KeyboardEvent } from "react"
import { MessageSquare, Trash2, Square, Pin, PinOff } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { UseChatReturn, CellContext } from "@/hooks/useChat"

export interface ChatDockPanelProps {
  chat: UseChatReturn
  /** The currently focused cell; wired in ProjectWorkspace via focusedCellIdRef */
  currentCell: CellContext | null
}

export function ChatDockPanel({ chat, currentCell }: ChatDockPanelProps) {
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
  const messagesRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Auto-scroll within the message list only — never scrollIntoView, which
  // walks ancestor scroll containers (the aside rail) and drifts chrome up.
  useEffect(() => {
    const el = messagesRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" })
  }, [messages, streamingText])

  // Focus the textarea when the panel mounts without scrolling ancestors.
  useEffect(() => {
    setTimeout(() => textareaRef.current?.focus({ preventScroll: true }), 50)
  }, [])

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
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between border-b px-3 py-2">
        <div className="flex items-center gap-2">
          <MessageSquare className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-xs font-medium">AI Chat</span>
        </div>
        {hasHistory && (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={clearHistory}
            title="Clear conversation"
            aria-label="Clear conversation"
          >
            <Trash2 className="h-3 w-3" />
          </Button>
        )}
      </div>

      {/* Context toggle strip */}
      <div className="flex items-center gap-2 border-b bg-muted/40 px-3 py-1.5">
        <button
          type="button"
          onClick={() => setIncludeCellContext(!includeCellContext)}
          className={cn(
            "flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] transition-colors",
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
            <Pin className="h-2.5 w-2.5" />
          ) : (
            <PinOff className="h-2.5 w-2.5" />
          )}
          {includeCellContext && currentCell
            ? currentCell.context
              ? `Cell: ${currentCell.context}`
              : "Cell context on"
            : "No cell context"}
        </button>
        {includeCellContext && currentCell && (
          <span
            className="truncate text-[10px] text-muted-foreground"
            title={currentCell.sourceText}
          >
            {currentCell.sourceText.length > 30
              ? currentCell.sourceText.slice(0, 30) + "…"
              : currentCell.sourceText}
          </span>
        )}
      </div>

      {/* Message list */}
      <div ref={messagesRef} className="flex-1 overflow-y-auto">
        {!isConfigured && messages.length === 0 && !isStreaming && (
          <div className="p-3 text-xs text-muted-foreground">
            Configure an AI provider in project settings to start chatting.
          </div>
        )}
        {messages.length === 0 && !isStreaming && isConfigured && (
          <div className="p-3 text-xs text-muted-foreground">
            Ask anything about the current passage, source meaning, or translation strategy.
            {includeCellContext && currentCell && (
              <span className="mt-1 block text-[10px]">
                The current cell will be included as context.
              </span>
            )}
          </div>
        )}
        <div className="flex flex-col gap-2.5 px-3 py-2">
          {messages.map((msg, i) => (
            <DockChatBubble key={i} role={msg.role} content={msg.content} />
          ))}
          {isStreaming && (
            <DockChatBubble role="assistant" content={streamingText} isStreaming />
          )}
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div className="border-t bg-destructive/10 px-3 py-1.5 text-[10px] text-destructive">
          {error}
        </div>
      )}

      {/* Composer */}
      <div className="border-t p-2">
        <div className="flex flex-col gap-1.5">
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask a question… (⌘↵ to send)"
            rows={3}
            disabled={isStreaming || !isConfigured}
            className={cn(
              "w-full resize-none rounded-md border bg-background px-2.5 py-1.5 text-xs",
              "placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring",
              "disabled:opacity-50",
            )}
          />
          <div className="flex items-center justify-between">
            <span className="text-[9px] text-muted-foreground">⌘↵ to send</span>
            <div className="flex items-center gap-1">
              {isStreaming && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={stopStreaming}
                  className="h-6 gap-1 text-[10px]"
                >
                  <Square className="h-2.5 w-2.5" />
                  Stop
                </Button>
              )}
              <Button
                size="sm"
                onClick={handleSend}
                disabled={!draft.trim() || isStreaming || !isConfigured}
                className="h-6 text-[10px]"
              >
                Send
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// DockChatBubble
// ---------------------------------------------------------------------------

interface DockChatBubbleProps {
  role: "user" | "assistant" | "system"
  content: string
  isStreaming?: boolean
}

function DockChatBubble({ role, content, isStreaming }: DockChatBubbleProps) {
  const isUser = role === "user"
  return (
    <div className={cn("flex", isUser ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[90%] rounded-xl px-2.5 py-1.5 text-xs",
          isUser
            ? "bg-primary text-primary-foreground"
            : "bg-muted text-foreground",
        )}
      >
        <pre
          className={cn(
            "whitespace-pre-wrap font-sans text-xs leading-relaxed",
            isStreaming &&
              "after:ml-0.5 after:inline-block after:h-3 after:w-0.5 after:animate-pulse after:bg-current after:align-middle after:content-['']",
          )}
        >
          {content || (isStreaming ? "" : "…")}
        </pre>
      </div>
    </div>
  )
}
