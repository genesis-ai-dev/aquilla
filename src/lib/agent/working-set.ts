/**
 * working-set.ts — derive the workbench's right-hand panel from a session.
 *
 * The working set is "the cells the agent is currently touching": every
 * PassageRow a tool result surfaced (read/draft/search data) merged, in
 * first-seen order, with staged target.cell.commit proposals overlaid as
 * pending diffs (proposed vs current). Pure derivation from AgentRunUi[] so
 * it needs no extra state and is unit-testable.
 */

import type { PassageRow, StagedEvent } from "./protocol"
import type { AgentRunUi } from "./run-state"

export interface WorkingSetRow extends PassageRow {
  /** Staged-but-unapplied target.cell.commit value, when one exists. */
  proposed?: string
  /** The proposal the pending value came from (for per-row apply). */
  proposalId?: string
  /** The staged event itself — handed to applyStagedEvents on accept. */
  stagedEvent?: StagedEvent
}

/** Stable per-proposal-row key for local accept/reject bookkeeping. */
export function proposalRowKey(proposalId: string, cellId: string): string {
  return `${proposalId}:${cellId}`
}

/**
 * Fold a session's runs (oldest → newest) into working-set rows. Later
 * sightings of a cell update its text/status; staged commits overlay a
 * `proposed` value until `decided` (applied or rejected locally) hides them.
 */
export function deriveWorkingSet(
  runs: AgentRunUi[],
  decided: ReadonlySet<string> = new Set(),
): WorkingSetRow[] {
  const rows = new Map<string, WorkingSetRow>()

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
          const key = proposalRowKey(item.proposal.proposalId, ev.cellId)
          if (decided.has(key)) {
            // Applied or rejected — the pending overlay disappears; an applied
            // value will come back as `target` on the next read/revalidate.
            upsert(ev.cellId, { proposed: undefined, proposalId: undefined, stagedEvent: undefined })
            continue
          }
          upsert(ev.cellId, {
            ...(ev.fileId ? { fileId: ev.fileId } : {}),
            ...(ev.display.canonicalRef ? { ref: ev.display.canonicalRef } : {}),
            proposed: typeof ev.payload.value === "string" ? ev.payload.value : ev.display.after ?? "",
            proposalId: item.proposal.proposalId,
            stagedEvent: ev,
          })
        }
      }
    }
  }

  return [...rows.values()]
}

/** Rows still carrying an undecided staged value (the review queue). */
export function pendingRows(rows: WorkingSetRow[]): WorkingSetRow[] {
  return rows.filter((r) => r.proposed !== undefined && r.stagedEvent)
}
