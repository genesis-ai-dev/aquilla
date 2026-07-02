/**
 * AgentWorkbench.tsx — the full-screen agent surface (/project/:id/agent).
 *
 * Two regions: the conversation (the SAME store-backed AgentDockView the
 * dock renders — expanding mid-run loses nothing) and the working set — the
 * cells the agent is touching, live from typed tool results, with staged
 * drafts reviewable per row. A job header shows bulk-run progress with Stop,
 * plus session controls (new session, back to editor).
 */

import { useCallback, useMemo, useState } from "react"
import { Bot, Minimize2, RotateCcw, Square } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { applyStagedEvents, type ApplyContext } from "@/lib/agent/apply"
import { useAgentSession } from "@/lib/agent/session-store"
import { deriveWorkingSet, proposalRowKey, type WorkingSetRow } from "@/lib/agent/working-set"
import { AgentDockView, type AgentDockViewProps } from "./AgentDockView"
import { WorkingSetPanel } from "./WorkingSetPanel"

export interface AgentWorkbenchProps {
  /** Same wiring the dock panel gets — one source of truth in ProjectWorkspace. */
  agent: Omit<AgentDockViewProps, "suggestedActions" | "pendingPrompt" | "onPendingPromptConsumed" | "pendingChip" | "onPendingChipConsumed">
  /** Leave the workbench (back to the editor). */
  onClose: () => void
  /** Jump the editor to a cell ("open" on a working-set row). */
  onJumpToCell?: (fileId: string, cellId: string) => void
}

export function AgentWorkbench({ agent, onClose, onJumpToCell }: AgentWorkbenchProps) {
  const { state, stop, reset } = useAgentSession(agent.projectId)
  // Locally decided (applied or rejected) proposal rows — key: proposalId:cellId.
  const [decided, setDecided] = useState<ReadonlySet<string>>(new Set())
  const [applying, setApplying] = useState(false)

  const rows = useMemo(() => deriveWorkingSet(state.runs, decided), [state.runs, decided])

  const activeRun = state.runs.find((r) => r.status === "running")
  const progress = activeRun?.progress

  const applyContext: ApplyContext = useMemo(
    () => ({
      projectId: agent.projectId,
      author: agent.author,
      resolveCell: agent.resolveCell
        ? (cellId) => {
            const cell = agent.resolveCell!(cellId)
            return cell
              ? { targetEventId: cell.targetEventId, sourceEventId: cell.sourceEventId }
              : undefined
          }
        : undefined,
    }),
    [agent.projectId, agent.author, agent.resolveCell],
  )

  const markDecided = useCallback((keys: string[]) => {
    setDecided((prev) => {
      const next = new Set(prev)
      for (const k of keys) next.add(k)
      return next
    })
  }, [])

  const acceptRows = useCallback(
    async (toApply: WorkingSetRow[]) => {
      const events = toApply.flatMap((r) => (r.stagedEvent ? [r.stagedEvent] : []))
      if (events.length === 0) return
      setApplying(true)
      try {
        const eventIds = await applyStagedEvents(events, applyContext)
        markDecided(toApply.map((r) => proposalRowKey(r.proposalId!, r.cellId)))
        await agent.onApplied?.(eventIds, toApply.map((r) => r.cellId))
      } finally {
        setApplying(false)
      }
    },
    [applyContext, markDecided, agent],
  )

  const pending = rows.filter((r) => r.proposed !== undefined && r.stagedEvent)

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Job header */}
      <div className="flex items-center gap-2 border-b px-3 py-1.5">
        <Bot className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium">Agent</span>
        {activeRun && (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground" role="status">
            <Spinner className="h-3 w-3" />
            {progress ? `${progress.label} — ${progress.done}/${progress.total}` : "working…"}
          </span>
        )}
        {state.queued.length > 0 && (
          <span className="text-[11px] text-muted-foreground">{state.queued.length} queued</span>
        )}
        <span className="ml-auto flex items-center gap-1">
          {state.isStreaming && (
            <Button type="button" variant="outline" size="sm" className="h-6 text-[11px]" onClick={stop}>
              <Square data-icon="inline-start" />
              Stop
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 text-[11px] text-muted-foreground"
            onClick={() => {
              reset()
              setDecided(new Set())
            }}
            title="Drop this conversation and start a fresh session"
          >
            <RotateCcw data-icon="inline-start" />
            New session
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 text-[11px] text-muted-foreground"
            onClick={onClose}
            title="Back to the editor"
            aria-label="Close workbench"
          >
            <Minimize2 data-icon="inline-start" />
            Editor
          </Button>
        </span>
      </div>

      {/* Two regions */}
      <div className="flex min-h-0 flex-1">
        <div className="flex w-[46%] min-w-[360px] max-w-[640px] flex-col border-r">
          <AgentDockView {...agent} />
        </div>
        <div className="min-w-0 flex-1">
          <WorkingSetPanel
            rows={rows}
            busy={applying}
            onAccept={(row) => acceptRows([row])}
            onAcceptAll={() => acceptRows(pending)}
            onReject={(row) => markDecided([proposalRowKey(row.proposalId!, row.cellId)])}
            onJumpToCell={onJumpToCell}
          />
        </div>
      </div>
    </div>
  )
}
