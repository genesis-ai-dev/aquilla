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
import { resolveEventLane } from '../../../src/lib/lanes/event-lane'
import type { LaneIdentity } from '../../../src/lib/lanes/read-wall'

/** One event, as much of it as the replay reads. */
export interface ChainReplayEvent {
  id: string
  kind: string
  fileId: string | null
  cellId: string | null
  parentId: string | null
  /**
   * The parsed payload, or null when it is unreadable. Only three things are
   * read from it: `targetLang` and `laneId` (the lane, via the AQU-1612
   * resolver) and, on a `source.cell.mirror`, `upstream.seq` and `adopt`.
   */
  payload: unknown
}

export class ChainHeadReplay {
  /** The current head per (file, cell, side, lane) — the key `cells` rows use. */
  private readonly headAt = new Map<string, string>()
  private readonly mirrorSeqAt = new Map<string, number>()
  private readonly lanes: readonly LaneIdentity[] | null

  /**
   * AQU-1612: pass the project's target lane rows and replay resolves each
   * event's lane by `laneId` first, falling back to the frozen `targetLang`
   * tag. Historical events carry only the tag, so they key exactly as before;
   * an event carrying both keys off its id. Without the rows (the mirror fold,
   * which walks an upstream project it holds no lane list for) the tag is the
   * only form read — which is why writers always stamp it too.
   */
  constructor(lanes: readonly LaneIdentity[] | null = null) {
    this.lanes = lanes
  }

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
      const key = headKey(event, this.lanes)
      if (isChainArbitrated(event.kind, event.parentId)) {
        const head = this.headAt.get(key)
        if (head !== undefined && head !== event.parentId) return false
      }
      if (event.kind.endsWith('.delete')) this.headAt.delete(key)
      else this.headAt.set(key, event.id)
    } else if (event.kind === 'source.cell.mirror') {
      const mirror = event.payload as { adopt?: unknown; upstream?: { seq?: unknown } } | null
      const seq = mirror?.upstream?.seq
      const key = headKey(event, this.lanes)
      const last = this.mirrorSeqAt.get(key)
      // AQU-1679: a mirror that joins an existing cell to its upstream applies
      // whatever seq the row held — the projection's own rule (see `adopt` on
      // the payload type).
      if (typeof seq === 'number' && (last === undefined || seq > last || mirror?.adopt === true)) {
        this.mirrorSeqAt.set(key, seq)
        this.headAt.set(key, event.id)
      }
    }
    return true
  }
}

function headKey(event: ChainReplayEvent, lanes: readonly LaneIdentity[] | null): string {
  const side = event.kind.startsWith('source.') ? 'source' : 'target'
  return `${event.fileId ?? ''}\0${event.cellId}\0${side}\0${replayLaneOf(event, lanes)}`
}

/**
 * The lane this event addresses, preferring `laneId` when the lane rows are in
 * hand. A source event never carries a lane, and an id this project does not
 * have falls back to the tag rather than failing a rebuild — the perimeter
 * already refuses such an event, so one in the log predates that check.
 */
function replayLaneOf(event: ChainReplayEvent, lanes: readonly LaneIdentity[] | null): string {
  if (!event.kind.startsWith('target.cell.')) return ''
  if (lanes === null) return laneOfEvent(event.kind, event.payload)
  const resolved = resolveEventLane(event.payload, lanes)
  return resolved.ok ? resolved.tag : laneOfEvent(event.kind, event.payload)
}
