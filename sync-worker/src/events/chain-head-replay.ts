// The head compare-and-swap, replayed from the event log (AQU-1154, invariant
// I1).
//
// Walking a project's log in server_seq order, a chain-arbitrated event (see
// isChainArbitrated) applies iff its parent_id IS the cell's head for its
// side/lane at that point, or the cell has no head yet. That is exactly what
// the live path's gated cells write enforces inside its transaction (commit
// order == seq order under the per-project seq lock). An event that loses is a
// stale sibling: it stays in `events` as history, and the projection never
// applied it.
//
// Two readers walk the log instead of reading `cells`, and both need this rule:
// rebuild.ts, which re-projects a project from scratch, and link-sync.ts's
// mirror fold (AQU-1574), which must not hand a downstream an edit its upstream
// rejected. One definition, so that rebuild == live == mirror — the same reason
// isChainArbitrated is shared by every arbitration site.

import { isChainArbitrated, isChainMutatingKind, laneOfEvent } from './event-projection'

/** One event, as much of it as the replay reads. */
export interface ChainReplayEvent {
  id: string
  kind: string
  fileId: string | null
  cellId: string | null
  parentId: string | null
  /**
   * The parsed payload, or null when it is unreadable. Only two things are
   * read from it: `targetLang` (the lane, via laneOfEvent) and, on a
   * `source.cell.mirror`, `upstream.seq`.
   */
  payload: unknown
}

export class ChainHeadReplay {
  /** The current head per (file, cell, side, lane) — the key `cells` rows use. */
  private readonly headAt = new Map<string, string>()
  private readonly mirrorSeqAt = new Map<string, number>()

  /**
   * Walk one event; events must come in server_seq order. Returns false iff it
   * is a stale sibling: a chain-arbitrated event that lost the compare-and-swap.
   *
   * A delete clears the head (the row is gone, so the next event on that key
   * applies whatever its parent, exactly as the live INSERT path does). A
   * parent-null delete is the trusted tombstone and never competes (AQU-931).
   * `source.cell.mirror` is not chain-arbitrated but DOES move the source head,
   * under its monotonic `upstream.seq` guard, so a later source event chained on
   * a mirror id finds it as the head.
   */
  apply(event: ChainReplayEvent): boolean {
    if (!event.cellId) return true
    if (isChainMutatingKind(event.kind)) {
      const key = headKey(event)
      if (isChainArbitrated(event.kind, event.parentId)) {
        const head = this.headAt.get(key)
        if (head !== undefined && head !== event.parentId) return false
      }
      if (event.kind.endsWith('.delete')) this.headAt.delete(key)
      else this.headAt.set(key, event.id)
    } else if (event.kind === 'source.cell.mirror') {
      const seq = (event.payload as { upstream?: { seq?: unknown } } | null)?.upstream?.seq
      const key = headKey(event)
      const last = this.mirrorSeqAt.get(key)
      if (typeof seq === 'number' && (last === undefined || seq > last)) {
        this.mirrorSeqAt.set(key, seq)
        this.headAt.set(key, event.id)
      }
    }
    return true
  }
}

function headKey(event: ChainReplayEvent): string {
  const side = event.kind.startsWith('source.') ? 'source' : 'target'
  return `${event.fileId ?? ''}\0${event.cellId}\0${side}\0${laneOfEvent(event.kind, event.payload)}`
}
