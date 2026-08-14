/**
 * working-set.ts — derive the workbench's right-hand panel from a session.
 *
 * The working set is "the cells the agent is currently touching": every
 * PassageRow a tool result surfaced (read/draft/search data) merged, in
 * first-seen order, with staged target.cell.commit proposals overlaid as
 * pending diffs (proposed vs current). Decided rows keep their outcome
 * (accepted / edited & accepted / rejected) so the grid reads as a record of
 * the session, not just a queue. Pure derivation from AgentRunUi[] so it
 * needs no extra state and is unit-testable.
 */

import type { PassageRow, StagedEvent } from "./protocol"
import type { AgentRunUi } from "./run-state"

/**
 * How a pending row was decided. "edited" = accepted with user changes;
 * "undone" = accepted then compensated back to the pre-run value (undo.ts).
 */
export type RowOutcome = "accepted" | "edited" | "rejected" | "undone"

export interface RowDecision {
  outcome: RowOutcome
  /** The committed text (post-edit) for accepted/edited rows; the RESTORED
   *  pre-run text for undone rows. */
  value?: string
  /** The event id the accept minted — the undo path's chain-head guard:
   *  a row is only undone while this is still the cell's winning head. */
  appliedEventId?: string
}

export interface WorkingSetRow extends PassageRow {
  /** AQU-846: destination file's display name, so a pending row says where it
   *  lands. Carried from the staged event's display context. */
  fileName?: string
  /** Staged-but-unapplied target.cell.commit value, when one exists. */
  proposed?: string
  /** The proposal the pending value came from (for per-row apply). */
  proposalId?: string
  /** The staged event itself — handed to applyStagedEvents on accept. */
  stagedEvent?: StagedEvent
  /** Set once the user decided this row; the pending overlay is gone. */
  outcome?: RowOutcome
}

/** Stable per-proposal-row key for local accept/reject bookkeeping. */
export function proposalRowKey(proposalId: string, cellId: string): string {
  return `${proposalId}:${cellId}`
}

/**
 * Fold a session's runs (oldest → newest) into working-set rows. Later
 * sightings of a cell update its text/status; staged commits overlay a
 * `proposed` value until decided, after which the row carries the outcome.
 *
 * Decisions out-rank tool data: the user decides AFTER every item in the
 * timeline existed, so an accepted/undone row's text is re-asserted in a
 * final pass. Without it, a read the model ran after staging (but before
 * the user accepted) still shows target="" and, sitting later in the
 * timeline, blanks the freshly accepted text.
 */
export function deriveWorkingSet(
  runs: AgentRunUi[],
  decided: ReadonlyMap<string, RowDecision> = new Map(),
): WorkingSetRow[] {
  const rows = new Map<string, WorkingSetRow>()
  // Per cell: the decision on the LAST proposal that touched it (cleared if
  // a newer undecided proposal re-stages the cell — its overlay must show).
  const finalDecision = new Map<string, RowDecision>()

  const upsert = (cellId: string, patch: Partial<WorkingSetRow>): void => {
    const existing = rows.get(cellId)
    if (existing) {
      rows.set(cellId, { ...existing, ...patch })
    } else {
      rows.set(cellId, { cellId, source: "", target: "", ...patch })
    }
  }

  for (const run of runs) {
    for (const item of run.items) {
      if (item.kind === "tool" && item.data?.cells) {
        for (const cell of item.data.cells) {
          upsert(cell.cellId, cell)
        }
      }
      if (item.kind === "proposal") {
        for (const ev of item.proposal.events) {
          if (ev.kind !== "target.cell.commit" || !ev.cellId) continue
          const decision = decided.get(proposalRowKey(item.proposal.proposalId, ev.cellId))
          if (decision) {
            // Decided — drop the pending overlay but keep the outcome.
            upsert(ev.cellId, {
              ...(ev.fileId ? { fileId: ev.fileId } : {}),
              ...(ev.display.fileName ? { fileName: ev.display.fileName } : {}),
              ...(ev.display.canonicalRef ? { ref: ev.display.canonicalRef } : {}),
              proposed: undefined,
              proposalId: undefined,
              stagedEvent: undefined,
              outcome: decision.outcome,
            })
            finalDecision.set(ev.cellId, decision)
            continue
          }
          upsert(ev.cellId, {
            ...(ev.fileId ? { fileId: ev.fileId } : {}),
            ...(ev.display.fileName ? { fileName: ev.display.fileName } : {}),
            ...(ev.display.canonicalRef ? { ref: ev.display.canonicalRef } : {}),
            proposed: typeof ev.payload.value === "string" ? ev.payload.value : ev.display.after ?? "",
            proposalId: item.proposal.proposalId,
            stagedEvent: ev,
            outcome: undefined,
          })
          finalDecision.delete(ev.cellId)
        }
      }
    }
  }

  // Final pass: the decided text wins over any tool-data sighting above.
  for (const [cellId, decision] of finalDecision) {
    if (decision.outcome !== "rejected" && decision.value !== undefined) {
      upsert(cellId, { target: decision.value })
    }
  }

  return [...rows.values()]
}

/** Rows still carrying an undecided staged value (the review queue). */
export function pendingRows(rows: WorkingSetRow[]): WorkingSetRow[] {
  return rows.filter((r) => r.proposed !== undefined && r.stagedEvent)
}
