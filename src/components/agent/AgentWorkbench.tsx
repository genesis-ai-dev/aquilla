/**
 * AgentWorkbench.tsx — the full-screen agent surface (/project/:id/agent).
 *
 * Surface ownership (agent-mode-v2 review-loop redesign): the chat is a
 * NARROW RAIL that narrates — proposals render there as compact receipts
 * with live counters — and the working set is the single review surface,
 * with draft text editable in place before accepting. Accept commits what's
 * in the box (the human post-edits the machine draft), through the same
 * staged-apply outbox path as ever. A job header shows bulk-run progress
 * with Stop, plus session controls (new session, back to editor).
 */

import { useCallback, useMemo, useRef, useState } from "react"
import { Bot, Minimize2, RotateCcw, Square } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { applyStagedEvents, type ApplyContext } from "@/lib/agent/apply"
import type { AgentProposal } from "@/lib/agent/protocol"
import { useAgentSession } from "@/lib/agent/session-store"
import { buildUndoEvents } from "@/lib/agent/undo"
import {
  deriveWorkingSet,
  pendingRows,
  proposalRowKey,
  type RowDecision,
  type WorkingSetRow,
} from "@/lib/agent/working-set"
import { checkRulesForCell } from "@/lib/rules/rule-engine"
import { AgentDockView, type AgentDockViewProps } from "./AgentDockView"
import { lintCellFor } from "./ProposalCard"
import { ProposalReceipt } from "./ProposalReceipt"
import { WorkingSetPanel, type WorkingSetPanelHandle } from "./WorkingSetPanel"

export interface AgentWorkbenchProps {
  /** Same wiring the dock panel gets — one source of truth in ProjectWorkspace. */
  agent: Omit<AgentDockViewProps, "suggestedActions" | "pendingPrompt" | "onPendingPromptConsumed" | "pendingChip" | "onPendingChipConsumed">
  /** Leave the workbench (back to the editor). */
  onClose: () => void
  /** Jump the editor to a cell ("open" on a working-set row). */
  onJumpToCell?: (fileId: string, cellId: string) => void
}

export function AgentWorkbench({ agent, onClose, onJumpToCell }: AgentWorkbenchProps) {
  const { state, stop, reset, decide } = useAgentSession(agent.projectId)
  // Decisions per proposal row (key: proposalId:cellId) live in the SESSION
  // store, not here — closing/reopening the workbench must not forget what
  // was applied (that would re-offer applied drafts and drop Undo).
  const decided = state.decided
  const [applying, setApplying] = useState(false)
  const panelRef = useRef<WorkingSetPanelHandle>(null)

  const rows = useMemo(() => deriveWorkingSet(state.runs, decided), [state.runs, decided])
  const pending = useMemo(() => pendingRows(rows), [rows])

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

  // ── Rule lint (same engine as the editor / ProposalCard) ────────────────
  const enabledRules = useMemo(() => agent.rules.filter((r) => r.enabled), [agent.rules])
  const lintRow = useCallback(
    (row: WorkingSetRow, text: string): string[] => {
      if (!row.stagedEvent || enabledRules.length === 0) return []
      const cell = lintCellFor(row.stagedEvent, agent.resolveCell, text)
      return checkRulesForCell(cell, row.stagedEvent.fileId ?? row.fileId ?? "", enabledRules).map(
        (inf) => inf.message,
      )
    },
    [enabledRules, agent.resolveCell],
  )

  // ── Accept / reject ──────────────────────────────────────────────────────
  const acceptRows = useCallback(
    async (toApply: { row: WorkingSetRow; value: string }[]) => {
      const staged = toApply.filter(({ row }) => row.stagedEvent && row.proposalId)
      if (staged.length === 0) return
      // Accept commits what's in the box: clone each staged event with the
      // (possibly edited) text before it goes through the apply path.
      const events = staged.map(({ row, value }) => ({
        ...row.stagedEvent!,
        payload: { ...row.stagedEvent!.payload, value },
        display: { ...row.stagedEvent!.display, after: value },
      }))
      setApplying(true)
      try {
        const eventIds = await applyStagedEvents(events, applyContext)
        decide(
          staged.map(({ row, value }, i): [string, RowDecision] => [
            proposalRowKey(row.proposalId!, row.cellId),
            {
              outcome: value === row.proposed ? "accepted" : "edited",
              value,
              // The undo path's chain-head guard: undo only while this is
              // still the cell's winning head.
              appliedEventId: eventIds[i],
            },
          ]),
        )
        await agent.onApplied?.(eventIds, staged.map(({ row }) => row.cellId))
      } finally {
        setApplying(false)
      }
    },
    [applyContext, agent, decide],
  )

  // ── Undo (compensation, not deletion): emit commits restoring each
  //    accepted row's pre-run value through the SAME apply path. Rows whose
  //    chain head moved on since the accept are skipped, not clobbered.
  const undoProposal = useCallback(
    async (proposal: AgentProposal) => {
      const plan = buildUndoEvents(proposal, decided, (cellId) =>
        agent.resolveCell?.(cellId)?.targetEventId,
      )
      if (plan.events.length === 0) return
      setApplying(true)
      try {
        const eventIds = await applyStagedEvents(plan.events, applyContext)
        decide(
          plan.cellIds.map((cellId, i): [string, RowDecision] => [
            proposalRowKey(proposal.proposalId, cellId),
            {
              outcome: "undone",
              value: plan.restoredValues.get(cellId),
              appliedEventId: eventIds[i],
            },
          ]),
        )
        await agent.onApplied?.(eventIds, plan.cellIds)
      } finally {
        setApplying(false)
      }
    },
    [decided, applyContext, agent, decide],
  )

  const rejectRow = useCallback(
    (row: WorkingSetRow) => {
      if (!row.proposalId) return
      decide([[proposalRowKey(row.proposalId, row.cellId), { outcome: "rejected" }]])
    },
    [decide],
  )

  // ── Receipt rendering (chat shows counters, not a second diff) ──────────
  const renderProposalOverride = useCallback(
    (proposal: AgentProposal) => {
      const commits = proposal.events.filter((ev) => ev.kind === "target.cell.commit" && ev.cellId)
      // Mixed/non-commit proposals aren't reviewable in the grid — fall back
      // to the full card (returning null does that).
      if (commits.length === 0 || commits.length !== proposal.events.length) return null
      let accepted = 0
      let edited = 0
      let rejected = 0
      let undone = 0
      let pendingCount = 0
      let checks = 0
      for (const ev of commits) {
        const decision = decided.get(proposalRowKey(proposal.proposalId, ev.cellId!))
        if (!decision) {
          pendingCount++
          if (enabledRules.length > 0) {
            checks += checkRulesForCell(
              lintCellFor(ev, agent.resolveCell),
              ev.fileId ?? "",
              enabledRules,
            ).length
          }
        } else if (decision.outcome === "accepted") accepted++
        else if (decision.outcome === "edited") edited++
        else if (decision.outcome === "undone") undone++
        else rejected++
      }
      return (
        <ProposalReceipt
          key={proposal.proposalId}
          proposal={proposal}
          counts={{ accepted, edited, rejected, undone, pending: pendingCount, checks }}
          onReview={() => panelRef.current?.focusFirstPending()}
          onUndo={applying ? undefined : () => undoProposal(proposal)}
        />
      )
    },
    [decided, enabledRules, agent.resolveCell, applying, undoProposal],
  )

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
            onClick={reset}
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

      {/* Chat is the SPINE (agent-complete §2): until the session surfaces an
          artifact, the conversation is the whole surface — a centered column,
          not a narrow rail beside an empty grid. The working set is a STAGE
          summoned when rows exist, and the chat becomes its side narrator. */}
      <div className="flex min-h-0 flex-1">
        {rows.length > 0 ? (
          <>
            <div className="flex w-[380px] min-w-[320px] flex-none flex-col border-r">
              <AgentDockView {...agent} renderProposalOverride={renderProposalOverride} />
            </div>
            <div className="min-w-0 flex-1">
              <WorkingSetPanel
                ref={panelRef}
                rows={rows}
                busy={applying}
                lintRow={lintRow}
                onAccept={(row, value) => acceptRows([{ row, value }])}
                onAcceptAll={(valueFor) =>
                  acceptRows(pending.map((row) => ({ row, value: valueFor(row) })))
                }
                onReject={rejectRow}
                onJumpToCell={onJumpToCell}
              />
            </div>
          </>
        ) : (
          <div className="mx-auto flex w-full max-w-3xl min-w-0 flex-col">
            <AgentDockView {...agent} renderProposalOverride={renderProposalOverride} />
          </div>
        )}
      </div>
    </div>
  )
}
