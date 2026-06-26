/**
 * AgentDockPanel.tsx — FRO-320
 *
 * Inline AI agent panel for the left dock. Renders AgentDockView in the dock's
 * compact column layout, with a header and (for scripture files) Summarize
 * book/chapter buttons that run an agent-backed, vetted-resource summary.
 */

import { useMemo, useState } from "react"
import { Bot } from "lucide-react"
import type { CellContext } from "@/lib/cell-context"
import type { ContextChip } from "@/lib/agent/context-chip"
import { AgentDockView, type AgentDockViewProps } from "./agent/AgentDockView"
import type { SuggestedAction } from "./chat/ChatComposer"
import { bookSummaryPrompt, chapterSummaryPrompt } from "@/lib/summary-prompts"

/** Scripture context that powers the Summarize book/chapter buttons. */
export interface BibleSummaryContext {
  /** The open book's display name (drives "Summarize book"). */
  bookName?: string
  /** The focused cell's chapter ref, e.g. "GEN 1" (drives "Summarize chapter").
   *  Null when no verse is focused — the chapter button is then disabled. */
  chapterRef?: string | null
}

export interface AgentDockPanelProps {
  /** The currently focused cell; wired in ProjectWorkspace via focusedCellIdRef */
  currentCell: CellContext | null
  /** Agent-run wiring. */
  agent: Omit<
    AgentDockViewProps,
    "currentCell" | "suggestedActions" | "pendingPrompt" | "onPendingPromptConsumed" | "pendingChip" | "onPendingChipConsumed"
  >
  /** When a scripture file is open, shows Summarize book/chapter buttons that
   *  run an agent-backed, vetted-resource summary. */
  bibleSummary?: BibleSummaryContext | null
  /** A source-selection chip to insert into the composer (set by EditorTable's "Ask AI"). */
  pendingChip?: ContextChip | null
  /** Called once the pending chip has been inserted. */
  onPendingChipConsumed?: () => void
}

export function AgentDockPanel({
  currentCell, agent, bibleSummary, pendingChip, onPendingChipConsumed,
}: AgentDockPanelProps) {
  // A summary prompt queued by a button tap; AgentDockView runs it once.
  const [pendingAgentPrompt, setPendingAgentPrompt] = useState<string | null>(null)

  // Summary buttons appear only when a scripture file is open. The chapter
  // button needs a focused verse.
  const summaryActions = useMemo<SuggestedAction[] | undefined>(() => {
    if (!bibleSummary) return undefined
    const actions: SuggestedAction[] = []
    const { bookName, chapterRef } = bibleSummary
    if (bookName) {
      actions.push({
        label: "Summarize book",
        title: `Summarize ${bookName} using vetted Bible resources, in your profile language`,
        onClick: () => setPendingAgentPrompt(bookSummaryPrompt(bookName)),
      })
    }
    actions.push({
      label: "Summarize chapter",
      title: chapterRef
        ? `Summarize ${chapterRef} using vetted Bible resources`
        : "Focus a verse to summarize its chapter",
      disabled: !chapterRef,
      onClick: () => chapterRef && setPendingAgentPrompt(chapterSummaryPrompt(chapterRef)),
    })
    return actions.length ? actions : undefined
  }, [bibleSummary])

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <Bot className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-xs font-medium">AI Agent</span>
      </div>

      <AgentDockView
        {...agent}
        currentCell={currentCell}
        suggestedActions={summaryActions}
        pendingPrompt={pendingAgentPrompt}
        onPendingPromptConsumed={() => setPendingAgentPrompt(null)}
        pendingChip={pendingChip}
        onPendingChipConsumed={onPendingChipConsumed}
      />
    </div>
  )
}
