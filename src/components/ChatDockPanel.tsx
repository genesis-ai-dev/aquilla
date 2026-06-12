/**
 * ChatDockPanel.tsx — FRO-320
 *
 * Inline AI chat panel for the left dock.
 * Same chat logic as ChatPanel.tsx (Sheet variant) but rendered as a
 * flex-column panel rather than a Sheet overlay. Composes the shared chat
 * components (src/components/chat/) in their compact sizing.
 *
 * Agent mode (translation-agent spec): when the optional `agent` prop is
 * provided, the header grows a Chat | Agent segmented toggle (same idiom as
 * EditorModeToggle) and Agent mode swaps the body for AgentDockView. Chat
 * mode — and every caller that omits `agent` — is byte-for-byte unchanged.
 */

import { useState } from "react"
import { Bot, MessageSquare } from "lucide-react"
import { cn } from "@/lib/utils"
import type { UseChatReturn, CellContext } from "@/hooks/useChat"
import { ChatContextPin } from "./chat/ChatContextPin"
import { ChatMessageList } from "./chat/ChatMessageList"
import { ChatComposer } from "./chat/ChatComposer"
import { ChatClearButton } from "./chat/ChatClearButton"
import { AgentDockView, type AgentDockViewProps } from "./agent/AgentDockView"

type DockMode = "chat" | "agent"

export interface ChatDockPanelProps {
  chat: UseChatReturn
  /** The currently focused cell; wired in ProjectWorkspace via focusedCellIdRef */
  currentCell: CellContext | null
  /** Commit plain text into the focused cell via the AI-completion commit path. */
  onInsertIntoCell?: (text: string) => void | Promise<void>
  /** Agent-mode wiring. Omit to render the classic chat-only dock. */
  agent?: Omit<AgentDockViewProps, "currentCell">
}

function ModeToggle({ mode, onChange }: { mode: DockMode; onChange: (mode: DockMode) => void }) {
  return (
    <div className="flex items-center gap-0.5 rounded-full border bg-muted/40 p-0.5 text-[10px]">
      <button
        type="button"
        onClick={() => mode !== "chat" && onChange("chat")}
        aria-pressed={mode === "chat"}
        className={cn(
          "flex items-center gap-1 rounded-full px-2 py-0.5 transition-all",
          mode === "chat"
            ? "bg-card font-medium text-foreground shadow-sm"
            : "text-muted-foreground hover:text-foreground",
        )}
      >
        <MessageSquare className="h-2.5 w-2.5" /> Chat
      </button>
      <button
        type="button"
        onClick={() => mode !== "agent" && onChange("agent")}
        aria-pressed={mode === "agent"}
        className={cn(
          "flex items-center gap-1 rounded-full px-2 py-0.5 transition-all",
          mode === "agent"
            ? "bg-card font-medium text-foreground shadow-sm"
            : "text-muted-foreground hover:text-foreground",
        )}
      >
        <Bot className="h-2.5 w-2.5" /> Agent
      </button>
    </div>
  )
}

export function ChatDockPanel({ chat, currentCell, onInsertIntoCell, agent }: ChatDockPanelProps) {
  const [mode, setMode] = useState<DockMode>("chat")
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
  const agentMode = mode === "agent" && agent

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between border-b px-3 py-2">
        <div className="flex items-center gap-2">
          {agentMode ? (
            <Bot className="h-3.5 w-3.5 text-muted-foreground" />
          ) : (
            <MessageSquare className="h-3.5 w-3.5 text-muted-foreground" />
          )}
          <span className="text-xs font-medium">{agentMode ? "AI Agent" : "AI Chat"}</span>
        </div>
        <div className="flex items-center gap-1.5">
          {agent && <ModeToggle mode={mode} onChange={setMode} />}
          {!agentMode && hasHistory && <ChatClearButton onClear={clearHistory} compact />}
        </div>
      </div>

      {agentMode ? (
        <AgentDockView {...agent} currentCell={currentCell} />
      ) : (
        <>
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
        </>
      )}
    </div>
  )
}
