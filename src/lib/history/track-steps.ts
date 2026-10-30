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
