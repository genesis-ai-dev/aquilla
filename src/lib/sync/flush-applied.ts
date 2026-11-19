// Lands the author's own write from the `POST /events` response.
//
// Before this module a commit cost three requests: the POST, then — after the
// outbox flush resolved — GET …/cells?cellIds= (row head) and
// GET /cells/audit-stats?cellId= (stats row). The server now returns the
// same `event.applied`-shaped frames it broadcasts to peers (`applied[]`),
// so the committing tab applies them through the existing `liveApplier`
// path and derives the stats entry from the projected row. The handler then
// asks `confirm()` whether either GET is still needed: only when the server
// did not carry the frame (older worker, >cap request, partial commit) or
// the stats entry could not be derived.
//
// AQU-2654: one edit is a commit AND the validation it casts for itself, and
// the socket echoes both back. The tracker therefore keys on the EVENT, not
// on the last frame seen for a cell (the validate frame used to overwrite the
// commit's entry, so every edit fell back to both GETs), settles a
// validation from the event that was sent, and is shared by the echo path so
// the response and the echo of one write cost no read between them.

import type { AppliedEventFrame, LiveApplier, LiveApplyResult } from "./live-apply"
import type { CellRow } from "./cells-read-types"
import type { OutboxRecord } from "./outbox"

/** Kinds whose audit-stats entry is fully implied by the projected row:
 *  `lastEditEventId` = the row's head, validators reset with the head, and
 *  waivers are untouched by a content commit. Validation events change
 *  `cell_validators` (not carried on the row) and keep hitting the GET. */
export function isStatsDerivableKind(kind: string): boolean {
  return (
    kind === "target.cell.commit" ||
    kind === "target.cell.create" ||
    kind === "source.cell.commit" ||
    kind === "source.cell.create"
  )
}

/** A queued event as the outbox holds it. */
export type SentEvent = Pick<OutboxRecord, "event">

function isValidationKind(kind: string): boolean {
  return kind === "cell.validate" || kind === "cell.unvalidate"
}

export interface FlushAppliedTracker {
  /** Feed every `applied[]` frame a flush returned. Frames for other
   *  projects/files are ignored (their store isn't mounted). `sent` is the
   *  batch the flush posted, by event id: a validation's stats entry is
   *  derived from the event itself (author + `editEventId`), which the frame
   *  does not carry. */
  onFrames(frames: AppliedEventFrame[], sent?: ReadonlyMap<string, SentEvent>): void
  /**
   * The socket echo of this user's own write on the mounted file, after the
   * caller ran it through `liveApplier` (`liveResult`). Settles the cell's
   * stats entry the same way the POST response does, once per event id
   * whichever of the two arrives first. A validation whose event can be found
   * neither in the response batch nor in the outbox (another device, or the
   * record already acked) falls back to ONE targeted stats read.
   */
  onOwnEcho(frame: AppliedEventFrame, liveResult: LiveApplyResult): void
  /**
   * Called by the committing handler after its flush resolved. Reports which
   * post-flush refetches are still required for `cellId` and forgets the
   * cell's entry. `eventId`, when the caller knows it, must be one of the
   * events the server applied for the cell — a mismatch (e.g. only an older
   * event's frame) falls back to both GETs.
   */
  confirm(cellId: string, eventId?: string): { refetchCell: boolean; refetchStats: boolean }
  /** True when every one of `eventIds` had its rows landed from a frame (POST
   *  response or own echo), so the store needs no reconciling read for them. */
  landed(eventIds: Iterable<string>): boolean
  /** Forget everything — call on file switch. */
  reset(): void
}

/**
 * One answer for a whole batch of own writes (AQU-2654).
 *
 * A model response is committed as one package of ~10 drafts in one POST. The
 * workspace used to follow every package with a file-level cells delta AND a
 * whole-file audit-stats read, whatever the response had carried — two reads
 * and two more workspace renders per ten cells, ~37 times over a 362-cell
 * file. The response already holds each accepted draft's projected row, so
 * the package is confirmed the way a single commit is: ask per cell, OR the
 * answers, and let the caller issue each read AT MOST ONCE and only if some
 * cell still needs it.
 *
 * `saved: false` is a draft the server refused, or that went stale and could
 * not be rebased: its optimistic shadow can only be replaced by the server's
 * row, so it always asks for both reads. `eventId` may be omitted when the
 * caller no longer holds it (a draft re-emitted onto a newer head) — the
 * frame that landed for the cell is then trusted, as in `confirm()`.
 */
export function confirmCommittedBatch(
  tracker: FlushAppliedTracker,
  writes: ReadonlyArray<{ cellId: string; eventId?: string; saved: boolean }>,
): { refetchCell: boolean; refetchStats: boolean } {
  let refetchCell = false
  let refetchStats = false
  for (const write of writes) {
    // Always consume the cell's entry, saved or not, so nothing stale is left
    // behind for a later commit of the same cell to be matched against.
    const landed = tracker.confirm(write.cellId, write.eventId)
    refetchCell ||= !write.saved || landed.refetchCell
    refetchStats ||= !write.saved || landed.refetchStats
  }
  return { refetchCell, refetchStats }
}

/** Ids remembered for `landed()` / echo de-duplication before the oldest are
 *  dropped; a forgotten id only costs the read it would have saved. */
const REMEMBERED_IDS_MAX = 4000

export function createFlushAppliedTracker(opts: {
  liveApplier: LiveApplier
  /** Is this frame's (project, file) the mounted store? */
  isActive(projectId: string, fileId: string): boolean
  /** Merge a derived stats entry for a committed cell. Return false when the
   *  hook could not (disabled / file mismatch) so the GET stays. */
  applyCommittedCellStats(cellId: string, rows: CellRow[]): boolean
  /** Merge the stats entry an applied validate/unvalidate implies. Return
   *  false when it cannot be derived faithfully, so the GET stays. */
  applyValidationCellStats?(sent: SentEvent): boolean
  /** The targeted stats read — the echo path's fallback. */
  revalidateCellStats?(cellId: string): void
  /** Look a queued event up by id (the outbox), for the echo path. */
  lookupSentEvent?(eventId: string): Promise<SentEvent | null>
}): FlushAppliedTracker {
  const landed = new Map<string, { eventIds: Set<string>; statsSettled: boolean }>()
  /** Events whose rows are in the store (from a frame at least as new). */
  const rowsLanded = new Set<string>()
  /** Events whose stats entry is settled: derived, or a read is on its way. */
  const statsSettled = new Set<string>()
  const remember = (set: Set<string>, id: string) => {
    if (set.size >= REMEMBERED_IDS_MAX) {
      for (const oldest of set) {
        set.delete(oldest)
        if (set.size < REMEMBERED_IDS_MAX / 2) break
      }
    }
    set.add(id)
  }
  /** Settle the stats entry for one applied event from data in hand. */
  const settleStats = (frame: AppliedEventFrame, rowsApplied: boolean, sent: SentEvent | undefined): boolean => {
    if (statsSettled.has(frame.id)) return true
    let settled = false
    if (isStatsDerivableKind(frame.kind)) {
      // Rows older than what the store holds must not drive the entry back.
      settled = rowsApplied && opts.applyCommittedCellStats(frame.cell as string, frame.rows as CellRow[])
    } else if (isValidationKind(frame.kind)) {
      settled = !!sent && !!opts.applyValidationCellStats?.(sent)
    }
    if (settled) remember(statsSettled, frame.id)
    return settled
  }
  return {
    onFrames(frames, sent) {
      for (const frame of frames) {
        if (!frame.cell || !frame.file || !opts.isActive(frame.project, frame.file)) continue
        const result = opts.liveApplier.apply(frame)
        if (result === "refetch") {
          // liveApplier already kicked revalidateCell: nothing landed for
          // THIS event, so confirm() must keep the fallback GETs.
          landed.delete(frame.cell)
          continue
        }
        // "ignored": the store already holds a projection at least as new as
        // this event (its own echo, or a later frame, got here first) — the
        // rows are landed all the same.
        remember(rowsLanded, frame.id)
        const settled = settleStats(frame, result === "applied", sent?.get(frame.id))
        const entry = landed.get(frame.cell) ?? { eventIds: new Set<string>(), statsSettled: true }
        entry.eventIds.add(frame.id)
        entry.statsSettled = entry.statsSettled && settled
        landed.set(frame.cell, entry)
      }
    },
    onOwnEcho(frame, liveResult) {
      const cell = frame.cell
      if (!cell) return
      // "refetch": a frame without rows — liveApplier fetches them itself.
      if (liveResult !== "refetch") remember(rowsLanded, frame.id)
      if (isStatsDerivableKind(frame.kind)) {
        settleStats(frame, liveResult === "applied", undefined)
        return
      }
      if (!isValidationKind(frame.kind) || statsSettled.has(frame.id)) return
      const fallback = () => {
        if (statsSettled.has(frame.id)) return
        remember(statsSettled, frame.id)
        opts.revalidateCellStats?.(cell)
      }
      if (!opts.lookupSentEvent) {
        fallback()
        return
      }
      void opts.lookupSentEvent(frame.id).then(
        (sent) => {
          // The POST response may have settled it while the lookup ran.
          if (statsSettled.has(frame.id)) return
          if (sent && settleStats(frame, false, sent)) return
          fallback()
        },
        fallback,
      )
    },
    confirm(cellId, eventId) {
      const entry = landed.get(cellId)
      landed.delete(cellId)
      if (!entry || (eventId !== undefined && !entry.eventIds.has(eventId))) {
        return { refetchCell: true, refetchStats: true }
      }
      // The caller reads the stats now; an echo of the same events that
      // arrives later must not read them a second time.
      if (!entry.statsSettled) for (const id of entry.eventIds) remember(statsSettled, id)
      return { refetchCell: false, refetchStats: !entry.statsSettled }
    },
    landed(eventIds) {
      for (const id of eventIds) if (!rowsLanded.has(id)) return false
      return true
    },
    reset() {
      landed.clear()
      rowsLanded.clear()
      statsSettled.clear()
    },
  }
}
