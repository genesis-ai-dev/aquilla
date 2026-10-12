// The head compare-and-swap, replayed from the event log (AQU-1154, invariant
// I1).
//
// Walking a project's log in server_seq order, a chain-arbitrated event (see
// isChainArbitrated) applies iff its parent_id IS the cell's head for its
// side/lane at that point, or the cell has no head yet. An event that loses is
// a stale sibling: it stays in `events` as history, and the projection never
// applied it.
//
// AQU-1844: seq order is NOT commit order. The live path's two gates are the
// `chain_claims` slot (first transaction to COMMIT wins) and the head CAS
// inside that transaction. Seq order used to stand in for commit order because
// the per-project seq counter's row lock was held across the write transaction
// — AQU-1005 moved allocation into its own autocommit statement, so A can hold
// the lower seq and still commit second. Live then keeps B and reports A in
// `stale[]`, while a seq-order replay picks A: the rebuild silently flips the
// cell and a downstream mirror shows an edit its upstream rejected.
//
// So replay reads the live arbitration instead of re-deriving it: pass the
// project's `chain_claims` rows as `claimWinners` (keyed by claimSlotKey) and
// an arbitrated event whose slot names a DIFFERENT event loses, whatever its
// seq. A slot with no claim row — every event older than chain_claims, and the
// paths that project ungated — keeps the pure seq-order rule, so those replays
// are byte-identical to before. The head CAS still runs on the claim winner:
// the claim is first-child-of-parent only, and a stale branch can hold an
// unclaimed (cell, loser) slot whose parent is not the head (AQU-1154).
//
// Two readers walk the log instead of reading `cells`, and both need this rule:
// rebuild.ts, which re-projects a project from scratch, and link-sync.ts's
// mirror fold (AQU-1574), which must not hand a downstream an edit its upstream
// rejected. One definition, so that rebuild == live == mirror — the same reason
// isChainArbitrated is shared by every arbitration site.

import { isChainArbitrated, isChainMutatingKind, laneOfEvent } from './event-projection'
import { eventQualifiedParentKey } from './chain-claims'
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

/**
 * AQU-1844: the key a `chain_claims` row arbitrates — the live claim slot, NOT
 * the head key above. `parent_key` is already side/lane-qualified in the table,
 * and the live claim site composes it with `eventQualifiedParentKey` off the raw
 * payload (see handlers/cell-events.ts), so replay must do the same or it would
 * look up a slot nothing ever claimed.
 */
export function claimSlotKey(event: ChainReplayEvent): string {
  const parentKey = eventQualifiedParentKey(event.parentId, event.kind, event.payload)
  return `${event.fileId ?? ''}\0${event.cellId ?? ''}\0${parentKey}`
}

/** One `chain_claims` row, as much of it as the replay reads. */
export interface ChainClaimRow {
  file_id: string
  cell_id: string
  parent_key: string
  event_id: string
}

/**
 * AQU-1844: the slot → live-winner map `ChainHeadReplay` arbitrates against.
 *
 * `presentEventIds` is the log being replayed. A claim whose winner is not in
 * it is DROPPED rather than honoured: honouring it would reject every sibling
 * of that slot and strand the chain there, which is strictly worse than the
 * seq-order fallback. Nothing prunes `chain_claims` today, so this only guards
 * a log that arrived without its claims (an event-level migration, a project
 * copy) — exactly the case that must keep the old behaviour.
 */
export function buildClaimWinners(
  rows: readonly ChainClaimRow[],
  presentEventIds: ReadonlySet<string>,
): Map<string, string> {
  const winners = new Map<string, string>()
  for (const r of rows) {
    if (!presentEventIds.has(r.event_id)) continue
    winners.set(`${r.file_id}\0${r.cell_id}\0${r.parent_key}`, r.event_id)
  }
  return winners
}

export class ChainHeadReplay {
  /** The current head per (file, cell, side, lane) — the key `cells` rows use. */
  private readonly headAt = new Map<string, string>()
  private readonly mirrorSeqAt = new Map<string, number>()
  private readonly lanes: readonly LaneIdentity[] | null
  private readonly claimWinners: ReadonlyMap<string, string> | null

  /**
   * AQU-1612: pass the project's target lane rows and replay resolves each
   * event's lane by `laneId` first, falling back to the frozen `targetLang`
   * tag. Historical events carry only the tag, so they key exactly as before;
   * an event carrying both keys off its id. Without the rows (the mirror fold,
   * which walks an upstream project it holds no lane list for) the tag is the
   * only form read — which is why writers always stamp it too.
   *
   * AQU-1844: `claimWinners` is the project's `chain_claims`, via
   * buildClaimWinners. Omit it and arbitration falls back to pure seq order —
   * correct only while no two siblings of one slot ever raced.
   */
  constructor(
    lanes: readonly LaneIdentity[] | null = null,
    claimWinners: ReadonlyMap<string, string> | null = null,
  ) {
    this.lanes = lanes
    this.claimWinners = claimWinners
  }

  /**
   * Walk one event; events must come in server_seq order. Returns false iff it
   * is a stale sibling: a chain-arbitrated event that lost its claim slot
   * (AQU-1844) or the head compare-and-swap.
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
        // AQU-1844: the live claim decides the slot when one was recorded —
        // the lower-seq sibling loses if it committed second. Both gates run,
        // in the live order: claim, then head CAS.
        const claimed = this.claimWinners?.get(claimSlotKey(event))
        if (claimed !== undefined && claimed !== event.id) return false
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
