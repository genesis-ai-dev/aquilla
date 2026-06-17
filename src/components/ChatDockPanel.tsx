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

import { useCallback, useMemo, useState } from "react"
import { Bot, MessageSquare } from "lucide-react"
import { cn } from "@/lib/utils"
import type { UseChatReturn, CellContext } from "@/hooks/useChat"
import { ChatContextPin } from "./chat/ChatContextPin"
import { ChatMessageList } from "./chat/ChatMessageList"
import { ChatComposer, type SuggestedAction } from "./chat/ChatComposer"
import { ChatClearButton } from "./chat/ChatClearButton"
import { AgentDockView, type AgentDockViewProps } from "./agent/AgentDockView"
import { bookSummaryPrompt, chapterSummaryPrompt } from "@/lib/summary-prompts"

type DockMode = "chat" | "agent"

/** Scripture context that powers the Summarize book/chapter buttons. */
export interface BibleSummaryContext {
  /** The open book's display name (drives "Summarize book"). */
  bookName?: string
  /** The focused cell's chapter ref, e.g. "GEN 1" (drives "Summarize chapter").
   *  Null when no verse is focused — the chapter button is then disabled. */
  chapterRef?: string | null
}

export interface ChatDockPanelProps {
  chat: UseChatReturn
  /** The currently focused cell; wired in ProjectWorkspace via focusedCellIdRef */
  currentCell: CellContext | null
  /** Commit plain text into the focused cell via the AI-completion commit path. */
  onInsertIntoCell?: (text: string) => void | Promise<void>
  /** Agent-mode wiring. Omit to render the classic chat-only dock. */
  agent?: Omit<AgentDockViewProps, "currentCell" | "suggestedActions" | "pendingPrompt" | "onPendingPromptConsumed">
  /** When a scripture file is open, shows Summarize book/chapter buttons that
   *  run an agent-backed, vetted-resource summary. Requires `agent`. */
  bibleSummary?: BibleSummaryContext | null
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

export function ChatDockPanel({
  chat,
  currentCell,
  onInsertIntoCell,
  agent,
  bibleSummary,
}: ChatDockPanelProps) {
  const [mode, setMode] = useState<DockMode>("chat")
  // A summary prompt queued by a button tap; AgentDockView runs it once.
  const [pendingAgentPrompt, setPendingAgentPrompt] = useState<string | null>(null)
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

  // Tapping a summary button switches to agent mode (summaries are agent-backed
  // so they can pull vetted Aquifer resources) and queues the prompt.
  const triggerSummary = useCallback((prompt: string) => {
    setMode("agent")
    setPendingAgentPrompt(prompt)
  }, [])

  // Summary buttons appear (in both chat and agent mode) only when a scripture
  // file is open AND agent mode is wired. The chapter button needs a focused verse.
  const summaryActions = useMemo<SuggestedAction[] | undefined>(() => {
    if (!agent || !bibleSummary) return undefined
    const actions: SuggestedAction[] = []
    const { bookName, chapterRef } = bibleSummary
    if (bookName) {
      actions.push({
        label: "Summarize book",
        title: `Summarize ${bookName} using vetted Bible resources, in your profile language`,
        onClick: () => triggerSummary(bookSummaryPrompt(bookName)),
      })
    }
    actions.push({
      label: "Summarize chapter",
      title: chapterRef
        ? `Summarize ${chapterRef} using vetted Bible resources`
        : "Focus a verse to summarize its chapter",
      disabled: !chapterRef,
      onClick: () => chapterRef && triggerSummary(chapterSummaryPrompt(chapterRef)),
    })
    return actions.length ? actions : undefined
  }, [agent, bibleSummary, triggerSummary])

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
        <AgentDockView
          {...agent}
          currentCell={currentCell}
          suggestedActions={summaryActions}
          pendingPrompt={pendingAgentPrompt}
          onPendingPromptConsumed={() => setPendingAgentPrompt(null)}
        />
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
            suggestedActions={summaryActions}
          />
        </>
      )}
    </div>
  )
}
