/**
 * History steps for timeline tracks: add, delete, rename, recolour, reorder,
 * folders. (AQU-1767 phase 2)
 *
 * One action is one step even when it touches several tracks (a bulk
 * recolour, making a folder from three tracks, a reorder that renumbers a
 * scope). Each change remembers the fields it wrote, before and after; undo
 * writes the before values back, field by field — a track's patch only ever
 * names the fields its verb owns (see applyTrackPatch in the workspace), and
 * the undo keeps to the same rule.
 *
 * ALL OR NOTHING. Track positions depend on each other, so if any track the
 * step touched has changed since, the whole step is skipped rather than
 * half-applied.
 *
 * DELETING A TRACK also removed its recordings (soft-deleted). Undo brings the
 * track back first and then the recordings, each chosen again where it was
 * the one playing.
 */
import type { StepHandler, StepOutcome } from "./history"

const DONE: StepOutcome = { kind: "done" }
const CHANGED: StepOutcome = { kind: "skipped", reason: "changed" }

/** The persisted fields of a track, as far as a patch can name them. */
export interface TrackFields {
  kind?: string
  name?: string | null
  order?: number | null
  groupId?: string | null
  color?: string | null
  sourceTrackId?: string | null
  contentFileId?: string | null
  /** AQU-2252: false = a layer; null = the default (sets its lines' lengths). */
  setsLineLengths?: boolean | null
}

/** `before` null = the track did not exist (it was added); `after` null = deleted. */
export interface TrackChange { trackId: string; before: TrackFields | null; after: TrackFields | null }
export interface TrackTake { cellId: string; audioId: string; fileId: string; slot: string; wasSelected: boolean }
export interface TrackStepData { changes: TrackChange[]; takes?: TrackTake[] }

export interface TrackStepContext {
  /** The track's current fields, or null when it does not exist. */
  readTrack(trackId: string): TrackFields | null
  /** One write for every change (null patch deletes the track). */
  patchTracks(changes: ReadonlyArray<{ trackId: string; patch: TrackFields | null }>): Promise<void>
  /** Bring recordings back (un-delete; re-choose those that were playing). */
  restoreTakes(takes: readonly TrackTake[]): Promise<void>
  removeTakes(takes: readonly TrackTake[]): Promise<void>
}

const FIELDS: ReadonlyArray<keyof TrackFields> = [
  "kind", "name", "order", "groupId", "color", "sourceTrackId", "contentFileId", "setsLineLengths",
]

function matches(current: TrackFields | null, expected: TrackFields | null): boolean {
  if (expected === null) return current === null
  if (current === null) return false
  for (const f of FIELDS) {
    if (!(f in expected)) continue
    if ((current[f] ?? null) !== (expected[f] ?? null)) return false
  }
  return true
}

/** The patch that takes a track from `from` to `to`. */
function patchFor(from: TrackFields | null, to: TrackFields | null): TrackFields | null {
  if (to === null) return null
  if (from === null) return { ...to }
  const patch: TrackFields = {}
  for (const f of FIELDS) {
    if (f in from || f in to) (patch as Record<string, unknown>)[f] = to[f] ?? null
  }
  // A kind has no null form, and it never changes on an existing track.
  if (patch.kind == null) delete patch.kind
  return patch
}

// ── What a track is NOW, before the project read has caught up ─────────────
//
// AQU-2492 (review, Nov 9): the "changed since?" guard read the last SETTLED
// track list. A change is written first and read back later (seconds on a
// hotspot), so an Undo pressed straight after deleting a track still saw the
// track there, called it "changed since", and threw the step away — and with
// it the only way back to the track's recordings. The same lost the Undo of a
// quick rename, reorder, colour or "Sets line lengths" change. Films already
// keep "written here, not read back yet" (`filmNow`); this is that, per track.

/** Changes written to one track from here that the project read has not shown yet. */
export interface PendingTrack {
  /** What the read said when the oldest of them was written. */
  readBefore: TrackFields | null
  /** What the track is after each write, oldest first (null = deleted). */
  states: Array<TrackFields | null>
}

/** The same track, field for field (a missing field and null are the same). */
function sameTrack(a: TrackFields | null, b: TrackFields | null): boolean {
  if (a === null || b === null) return a === b
  for (const f of FIELDS) {
    // Only `false` is ever stored for "sets line lengths"; anything else is the default.
    const norm = (v: unknown) => (f === "setsLineLengths" ? (v === false ? false : null) : (v ?? null))
    if (norm(a[f]) !== norm(b[f])) return false
  }
  return true
}

/** Note a write (`patch` null deletes): the track's pending changes after it. */
export function noteTrackWrite(
  read: TrackFields | null,
  pending: PendingTrack | undefined,
  patch: TrackFields | null,
): PendingTrack {
  const now = trackNow(read, pending)
  const next = patch === null ? null : { ...(now.track ?? {}), ...patch }
  return now.pending
    ? { readBefore: now.pending.readBefore, states: [...now.pending.states, next] }
    : { readBefore: read, states: [next] }
}

/**
 * The track as far as this tab knows: what was last written here, until the
 * project read shows it. A read that shows an EARLIER write of ours keeps the
 * later ones pending. Any other new answer settles it (a collaborator's
 * change, or the server tidying a value): the read is then the truth, so an
 * Undo checked against ours never writes over theirs. `pending` undefined:
 * forget it.
 */
export function trackNow(
  read: TrackFields | null,
  pending: PendingTrack | undefined,
): { track: TrackFields | null; pending: PendingTrack | undefined } {
  if (!pending || pending.states.length === 0) return { track: read, pending: undefined }
  const last = pending.states[pending.states.length - 1] ?? null
  let shown = -1
  for (let i = pending.states.length - 1; i >= 0; i--) {
    if (sameTrack(read, pending.states[i] ?? null)) { shown = i; break }
  }
  if (shown === pending.states.length - 1) return { track: read, pending: undefined }
  if (shown >= 0) return { track: last, pending: { readBefore: read, states: pending.states.slice(shown + 1) } }
  if (sameTrack(read, pending.readBefore)) return { track: last, pending }
  return { track: read, pending: undefined }
}

/**
 * AQU-2492 (review, Nov 9), finding 10: the notes above, kept PER FILE. The
 * built-in rows (the main Recordings row and its kin) have the same ids in
 * every file, and the workspace stays open across files, so notes keyed by
 * the track alone carried a change made in one chapter into the Undo of the
 * same row in another. A step belongs to the file it was made in; so does
 * what it reads.
 */
export class TrackWriteNotes {
  private readonly notes = new Map<string, PendingTrack>()
  private key(fileId: string, trackId: string): string {
    return `${fileId}\u0000${trackId}`
  }
  /** The track in `fileId` as far as this tab knows, given its settled read. */
  read(fileId: string, trackId: string, settled: TrackFields | null): TrackFields | null {
    const key = this.key(fileId, trackId)
    const now = trackNow(settled, this.notes.get(key))
    if (now.pending) this.notes.set(key, now.pending)
    else this.notes.delete(key)
    return now.track
  }
  /** A write to the track in `fileId` (`patch` null deletes it). */
  note(fileId: string, trackId: string, settled: TrackFields | null, patch: TrackFields | null): void {
    const key = this.key(fileId, trackId)
    this.notes.set(key, noteTrackWrite(settled, this.notes.get(key), patch))
  }
  /** Writes that were refused never show in a read: stop expecting them. */
  forget(fileId: string, trackIds: readonly string[]): void {
    for (const id of trackIds) this.notes.delete(this.key(fileId, id))
  }
}

export function trackStepHandlers(ctx: TrackStepContext): Record<string, StepHandler<never>> {
  const flip = async (d: TrackStepData, which: "undo" | "redo"): Promise<StepOutcome> => {
    for (const c of d.changes) {
      const expected = which === "undo" ? c.after : c.before
      if (!matches(ctx.readTrack(c.trackId), expected)) return CHANGED
    }
    // Undoing a delete brings a track back (its recordings follow); redoing one
    // removes it again (the row first, then its recordings — the order the
    // delete itself used, so a refused row never costs the recordings).
    const restoresTrack = d.changes.some((c) => c.after === null && c.before !== null)
    await ctx.patchTracks(
      d.changes.map((c) =>
        which === "undo"
          ? { trackId: c.trackId, patch: patchFor(c.after, c.before) }
          : { trackId: c.trackId, patch: patchFor(c.before, c.after) },
      ),
    )
    if (restoresTrack && d.takes?.length) {
      if (which === "undo") await ctx.restoreTakes(d.takes)
      else await ctx.removeTakes(d.takes)
    }
    return DONE
  }
  return {
    "track.patch": {
      undo: (d: TrackStepData) => flip(d, "undo"),
      redo: (d: TrackStepData) => flip(d, "redo"),
    } as StepHandler<never>,
  }
}

/** A timeline track's persisted fields, as a step remembers them. `keys`
 *  narrows it to the fields a verb wrote. */
export function trackFieldsOf(
  track: {
    kind: string
    name: string
    order: number
    groupId?: string | null
    color?: string | null
    sourceTrackId?: string | null
    contentFileId?: string | null
    setsLineLengths?: boolean
  },
  keys?: ReadonlyArray<keyof TrackFields>,
): TrackFields {
  const all: TrackFields = {
    kind: track.kind,
    name: track.name,
    order: track.order,
    groupId: track.groupId ?? null,
    color: track.color ?? null,
    sourceTrackId: track.sourceTrackId ?? null,
    contentFileId: track.contentFileId ?? null,
    // Only `false` is ever stored; the default reads as nothing stored.
    setsLineLengths: track.setsLineLengths === false ? false : null,
  }
  if (!keys) return all
  const picked: TrackFields = {}
  for (const k of keys) (picked as Record<string, unknown>)[k] = all[k]
  return picked
}
