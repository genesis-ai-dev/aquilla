/**
 * ChatDockPanel.tsx — FRO-320
 *
 * Inline AI chat panel for the left dock.
 * Same chat logic as ChatPanel.tsx (Sheet variant) but rendered as a
 * flex-column panel rather than a Sheet overlay. Composes the shared chat
 * components (src/components/chat/) in their compact sizing.
 */

import { MessageSquare } from "lucide-react"
import type { UseChatReturn, CellContext } from "@/hooks/useChat"
import { ChatContextPin } from "./chat/ChatContextPin"
import { ChatMessageList } from "./chat/ChatMessageList"
import { ChatComposer } from "./chat/ChatComposer"
import { ChatClearButton } from "./chat/ChatClearButton"

export interface ChatDockPanelProps {
  chat: UseChatReturn
  /** The currently focused cell; wired in ProjectWorkspace via focusedCellIdRef */
  currentCell: CellContext | null
  /** Commit plain text into the focused cell via the AI-completion commit path. */
  onInsertIntoCell?: (text: string) => void | Promise<void>
}

export function ChatDockPanel({ chat, currentCell, onInsertIntoCell }: ChatDockPanelProps) {
  const {
    messages,
    streamingText,
    isStreaming,
    includeCellContext,
    setIncludeCellContext,
    isConfigured,
    sendMessage,
    retryMessage,
    dismissMessage,
    regenerate,
    stopStreaming,
    clearHistory,
  } = chat

  const hasHistory = messages.length > 0 || isStreaming

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between border-b px-3 py-2">
        <div className="flex items-center gap-2">
          <MessageSquare className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-xs font-medium">AI Chat</span>
        </div>
        {hasHistory && <ChatClearButton onClear={clearHistory} compact />}
      </div>

      <ChatContextPin
        includeCellContext={includeCellContext}
        onToggle={setIncludeCellContext}
        currentCell={currentCell}
        compact
      />

      <ChatMessageList
        messages={messages}
        streamingText={streamingText}
        isStreaming={isStreaming}
        isConfigured={isConfigured}
        includeCellContext={includeCellContext}
        currentCell={currentCell}
        compact
        onInsertIntoCell={onInsertIntoCell}
        onRegenerate={() => void regenerate(currentCell)}
        onRetry={(msg) => void retryMessage(msg.id, currentCell)}
        onDismiss={(msg) => dismissMessage(msg.id)}
      />

      <ChatComposer
        isStreaming={isStreaming}
        isConfigured={isConfigured}
        onSend={(text) => void sendMessage(text, currentCell)}
        onStop={stopStreaming}
        compact
      />
    </div>
  )
}
