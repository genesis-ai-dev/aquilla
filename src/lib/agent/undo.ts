/**
 * undo.ts — compensating undo for applied agent drafts.
 *
 * Rollback is compensation, not deletion (design §5): undoing a proposal
 * emits NEW target.cell.commit events that restore each cell's pre-run value
 * (the staged event's display.before), through the same applyStagedEvents →
 * outbox path an accept uses. Append-only stays append-only and the undo is
 * itself audited via payload.undo_of_agent_run_id.
 *
 * Safety: a row is only undone while its chain head is one WE minted — the
 * accept's own event (RowDecision.appliedEventId) or, because reads are
 * thin-client and may lag the apply (AD-3: the outbox never overlays reads),
 * the pre-apply head the server pinned at stage time. A head that is neither
 * means someone — the user in the editor, a collaborator — committed on top
 * since; that row is SKIPPED rather than clobbered, and the caller surfaces
 * the skipped count.
 */

import type { AgentProposal, StagedEvent } from "./protocol"
import { proposalRowKey, type RowDecision } from "./working-set"

export interface UndoPlan {
  /** Compensating commits, ready for applyStagedEvents. */
  events: StagedEvent[]
  /** Cells the plan touches (parallel to events; for onApplied revalidation). */
  cellIds: string[]
  /** Restored text per cellId — for marking rows "undone" after apply. */
  restoredValues: Map<string, string>
  /** Accepted rows NOT undone because their chain head moved on. */
  skipped: number
}

/**
 * Build the compensating events for a proposal's accepted/edited rows.
 * `resolveHead` returns a cell's current targetEventId (live projection);
 * without it the head guard degrades to best-effort (rows are undone on the
 * strength of the staleness pin alone — the server chain guard still applies).
 */
export function buildUndoEvents(
  proposal: AgentProposal,
  decided: ReadonlyMap<string, RowDecision>,
  resolveHead?: (cellId: string) => string | undefined,
): UndoPlan {
  const events: StagedEvent[] = []
  const cellIds: string[] = []
  const restoredValues = new Map<string, string>()
  let skipped = 0

  for (const ev of proposal.events) {
    if (ev.kind !== "target.cell.commit" || !ev.cellId || !ev.fileId) continue
    const decision = decided.get(proposalRowKey(proposal.proposalId, ev.cellId))
    // Only applied rows can be undone; rejected/pending/already-undone rows
    // never wrote anything (or already compensated).
    if (!decision || decision.outcome === "rejected" || decision.outcome === "undone") continue

    // Foreign-head guard: skip only when the live head is neither the accept's
    // own event nor the (possibly lagging) pre-apply head from stage time.
    const head = resolveHead?.(ev.cellId)
    if (
      head &&
      decision.appliedEventId &&
      head !== decision.appliedEventId &&
      head !== ev.parentId
    ) {
      skipped++
      continue
    }

    const restored = ev.display.before ?? ""
    events.push({
      kind: "target.cell.commit",
      fileId: ev.fileId,
      cellId: ev.cellId,
      // Chain on the accept's own event — the head guard above ensures this
      // is still the winning head (live resolveCell re-confirms at apply).
      parentId: decision.appliedEventId,
      payload: {
        value: restored,
        // Keep the AD-9 pin the original staged commit carried, if any.
        ...(typeof ev.payload.sourceEventId === "string"
          ? { sourceEventId: ev.payload.sourceEventId }
          : {}),
        // Undo provenance — NOT agent_run_id (would inflate the run's applied
        // count) and no ai_suggestion (the restored text is human-authored).
        undo_of_agent_run_id: proposal.runId,
      },
      display: {
        ...(ev.display.canonicalRef ? { canonicalRef: ev.display.canonicalRef } : {}),
        before: decision.value ?? ev.display.after,
        after: restored,
      },
    })
    cellIds.push(ev.cellId)
    restoredValues.set(ev.cellId, restored)
  }

  return { events, cellIds, restoredValues, skipped }
}
