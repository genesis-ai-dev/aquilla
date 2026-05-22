/**
 * Optimistic overlay for D1-backed audit stats.
 *
 * D1 is the source of truth for validation status, but the outbox holds events
 * the client has produced that haven't been ack'd yet (offline edits, in-flight
 * batches). Without an overlay, a freshly toggled validate would not appear
 * until the next 30s refetch — users would see their click do nothing.
 *
 * This helper takes a base stats map (from useCellsAuditStats) plus the pending
 * outbox records and produces a derived map with the pending events applied.
 *
 * Rules:
 *  - cell.commit: stamps a synthetic `lastEditEventId = event.id`, increments
 *    `editCount`, updates `lastEditAt`, and CLEARS `activeValidators` (a new edit
 *    invalidates prior approvals).
 *  - cell.validate: adds the author to `activeValidators` and stamps the
 *    `editEventId` from the payload as `lastEditEventId` if a later commit
 *    didn't already overwrite it. Idempotent (set semantics).
 *  - cell.unvalidate: removes the author from `activeValidators`.
 *
 * Events are applied in `enqueuedAt` order so out-of-order user actions resolve
 * the same way the server would (LWW on decided_ts; commits invalidate prior
 * validators).
 */

import type { CellAuditStats } from "@/hooks/useCellsAuditStats"
import type { OutboxRecord } from "./outbox"
import type { CqrsEventKind, CqrsPayloadFor } from "./cqrs-types"

export interface OverlayInput {
  base: ReadonlyMap<string, CellAuditStats>
  /** Outbox records, oldest-first. Caller passes only events scoped to the
   *  file in question; the helper does not filter by fileId. */
  pending: ReadonlyArray<OutboxRecord>
}

export function applyOutboxOverlay(
  input: OverlayInput,
): Map<string, CellAuditStats> {
  const out = new Map<string, CellAuditStats>()
  // Shallow-clone every base entry so callers' map stays untouched.
  for (const [k, v] of input.base) {
    out.set(k, { ...v, activeValidators: [...v.activeValidators] })
  }

  for (const rec of input.pending) {
    const ev = rec.event
    const cellId = ev.cellId
    if (!cellId) continue

    // Synthesize a stub for cells the user touched offline before the projection
    // ever caught up — keeps the map consistent for callers that just lookup by
    // cellId.
    let stats = out.get(cellId)
    if (!stats) {
      stats = {
        cellId,
        editCount: 0,
        contentHash: "",
        lastEditAt: null,
        lastEditEventId: null,
        activeValidators: [],
      }
      out.set(cellId, stats)
    }

    if (ev.kind === "target.cell.commit" || ev.kind === "target.cell.create") {
      stats.editCount += 1
      stats.lastEditAt = ev.clientTs
      stats.lastEditEventId = ev.id
      // New edit drops prior approvals — server-side projection works the same way:
      // cells.validated is recomputed against the *current* edit_event_id.
      stats.activeValidators = []
    } else if (ev.kind === "cell.validate") {
      const p = ev.payload as CqrsPayloadFor<"cell.validate">
      // If the commit happened earlier in the outbox we already wrote
      // lastEditEventId; if not (e.g. a validate on an earlier server-side
      // edit), fall back to the payload's editEventId.
      if (!stats.lastEditEventId) stats.lastEditEventId = p.editEventId
      // Only surface the validator if it targets the current edit. A stale
      // validate (pointing at a prior editEventId) shouldn't bump the icon.
      if (stats.lastEditEventId === p.editEventId) {
        if (!stats.activeValidators.includes(ev.author)) {
          stats.activeValidators.push(ev.author)
        }
      }
    } else if (ev.kind === "cell.unvalidate") {
      const p = ev.payload as CqrsPayloadFor<"cell.unvalidate">
      if (stats.lastEditEventId === p.editEventId) {
        stats.activeValidators = stats.activeValidators.filter(
          (u) => u !== ev.author,
        )
      }
    }
  }

  return out
}

export type { CqrsEventKind }
