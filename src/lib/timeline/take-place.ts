// AQU-2267 (Sam, Oct 29: "B makes the most sense") — a take's place carries
// across both timings.
//
// WHAT IS STORED, PER TAKE (cell_audio, written by `cell.audio.place`):
//
//   target_offset_ms      its place FOLLOWING THE SOURCE: where its clip's start
//                         (sample zero) sits, in ms from its line's start. What
//                         `targetChipGeom` reads — the film's clock, the source
//                         playback, the exports placed by time.
//   recordings_offset_ms  its place FOLLOWING THE RECORDINGS, measured the same
//                         way from its line's start in that layout (from the
//                         start of its slot on a book's line, which has no
//                         times). What `buildProgramme` reads — the pause before
//                         a voice take, where a layer's clip starts.
//
// Before AQU-2267 there was only the first, and both timings read it. So a move
// in one timing replaced the place in the other: a LOTE sermon take 1.0 s
// before its line following the source, dragged 0.2 s following the recordings
// (where a voice take cannot start before its line), stored "line start + 0.2"
// and came back +0.2 following the source.
//
// A MOVE NOW MOVES THE TAKE BY THE SAME DISTANCE IN BOTH TIMINGS, each held by
// its own timing's limits. The distance is measured in the timing it was made
// in, from where the take was drawn there to where it was dropped (after that
// timing's own clamp). Then each place moves by it:
//   - following the source: the end-based bounds against its line, its
//     neighbours on the track, never before the start of the file;
//   - following the recordings, on the main track or a voice track: never
//     before its line's start (a pause cannot be negative);
//   - following the recordings, on a layer: its lead-in limit, the takes either
//     side of it on its track, never before the start of the file (AQU-2252).
// A timing that cannot place the take at all (a book's line has no place on
// the film's clock; a take of unknown length holds no pause) still moves its
// number by the same distance, so the two stay in step for when it can.
//
// OLD DATA: a take with no place of its own following the recordings reads its
// place following the source there, exactly as before. Its first move gives it
// both. The one-number event an older client sends gives it one place again.

import type { CellData } from "@/hooks/useCells"
import { buildTimelineLayout, type TimelineLayout } from "./layout"
import {
  maxAudibleStartSec,
  minAudibleEndSec,
  targetChipGeom,
  targetOffsetMsFor,
  type SpanSec,
} from "./lane-timing"

/** What a move stores: the take's place in each timing, in ms from its line's start. */
export interface TakePlace {
  /** Following the source — `cell_audio.target_offset_ms`. */
  targetOffsetMs: number
  /** Following the recordings — `cell_audio.recordings_offset_ms`. */
  recordingsOffsetMs: number
}

/** A take on a track: what a lane draws one chip from. */
export interface PlacedTake {
  cell: CellData
  audioId: string
}

/** What bounds a MOVE of one chip, on its layout's own clock. */
export interface MoveClamp {
  /**
   * Following the recordings, a take on the main track or a voice track: its
   * line grows to hold it, so the only bound is its line's start.
   */
  free: boolean
  /** Where its line starts on the programme clock (the free bound). */
  lineStartSec: number | null
  /** The span it is measured against (`TimelineLayout.chipSection`). */
  section: SpanSec
  /** Its audible length. */
  lenSec: number
  /** The audible starts of the chips either side of it on its track. */
  prevChipStartSec: number | null
  nextChipStartSec: number | null
  /** Its head trim: an audible start below it would put its clip's start
   *  before the start of the file. */
  trimStartSec: number
}

/**
 * Where a moved chip's audible START may go — the move arm of the lane's
 * `proposeSpan`, as one function, so the timing a move is made in and the
 * timing it is carried into clamp by the same arithmetic.
 *
 * Not free: the END-based bounds (a chip may slide back into the previous
 * line's space, but its end may not pass its line's start, nor its start its
 * line's end), neither neighbour's start, and never before file zero — the
 * floors applied last, so they win when the bounds cross.
 */
export function clampMoveStart(start: number, c: MoveClamp): number {
  if (c.free) return Math.max(start, c.lineStartSec ?? start)
  const capped = Math.min(start, maxAudibleStartSec(c.section), c.nextChipStartSec ?? Infinity)
  return Math.max(capped, minAudibleEndSec(c.section) - c.lenSec, c.prevChipStartSec ?? -Infinity, c.trimStartSec)
}

/** Follows source's layout, for a lane drawn without one (its own tests). */
const FILE_CLOCK: TimelineLayout = buildTimelineLayout("dubbing", [], [])

type Timing = "source" | "recordings"
const timingOf = (layout: TimelineLayout): Timing => (layout.mode === "audioFirst" ? "recordings" : "source")

/**
 * The take's place in one timing as that timing reads it NOW, in ms — for a
 * timing that cannot place the take (see the header). Following the source:
 * its own place, else its line's (the pre-AQU-646-stage-3 rungs). Following
 * the recordings: its own place there, else its place following the source.
 */
function placeNowMs(cell: CellData, audioId: string, timing: Timing): number {
  const att = cell.attachments?.[audioId]
  if (timing === "recordings") {
    const ms = att?.recordingsOffsetMs
    if (typeof ms === "number" && Number.isFinite(ms)) return ms
  }
  const own = att?.targetOffsetMs
  if (typeof own === "number" && Number.isFinite(own)) return own
  const geom = targetChipGeom(cell, att)
  return geom && typeof cell.startTime === "number" ? Math.round((geom.anchor - cell.startTime) * 1000) : 0
}

/**
 * Where the take's audible start lands, on `layout`'s clock, when it moves
 * `deltaSec` there — held by that timing's limits, as the lane's move arm
 * holds a drag. Null when that layout cannot move it. `track` is every take on
 * the take's track, for its neighbours there.
 */
export function movedStartSec(
  layout: TimelineLayout,
  track: readonly PlacedTake[],
  take: PlacedTake,
  deltaSec: number,
): number | null {
  const { cell, audioId } = take
  if (!layout.canRetimeTarget(cell, cell.attachments?.[audioId], audioId)) return null
  const isTake = (t: PlacedTake) => t.cell.id === cell.id && t.audioId === audioId
  // The track as that layout draws it, left to right — the lane's own order.
  const chips: { take: PlacedTake; start: number; end: number; trimStartSec: number; section: SpanSec }[] = []
  for (const t of track.some(isTake) ? track : [...track, take]) {
    const a = t.cell.attachments?.[t.audioId]
    const geom = layout.targetGeom(t.cell, a, t.audioId)
    const section = layout.chipSection(t.cell, a, t.audioId)
    if (geom && section) chips.push({ take: t, start: geom.start, end: geom.end, trimStartSec: geom.trimStartSec, section })
  }
  chips.sort((x, y) => x.start - y.start)
  const i = chips.findIndex((c) => isTake(c.take))
  if (i < 0) return null
  const chip = chips[i]
  return clampMoveStart(chip.start + deltaSec, {
    free: layout.mode === "audioFirst" && layout.takeRole(cell, audioId) !== "layer",
    lineStartSec: layout.programme?.byCellId.get(cell.id)?.startSec ?? null,
    section: chip.section,
    lenSec: chip.end - chip.start,
    prevChipStartSec: chips[i - 1]?.start ?? null,
    nextChipStartSec: chips[i + 1]?.start ?? null,
    trimStartSec: chip.trimStartSec,
  })
}

/**
 * The take's place in `layout`'s timing after it moves `deltaSec` there, held
 * by that timing's limits (`movedStartSec`), in ms from its line's start — or
 * null when that layout cannot place it.
 */
export function placeAfterMoveMs(
  layout: TimelineLayout,
  track: readonly PlacedTake[],
  take: PlacedTake,
  deltaSec: number,
): number | null {
  const start = movedStartSec(layout, track, take, deltaSec)
  if (start == null) return null
  const anchor = layout.retimeAnchorSec(take.cell, take.cell.attachments?.[take.audioId], start, take.audioId)
  return anchor == null ? null : targetOffsetMsFor(take.cell, anchor)
}

export interface MovedTake {
  /** The FILE-clock anchor the move asks for in the timing it was made in —
   *  what a move has always handed up (its offset from the line's start is
   *  the place there). */
  anchorSec: number
  /** What to store: the take's place in each timing. */
  place: TakePlace
}

/**
 * A take dropped at `toStartSec` (its audible start, on `here`'s clock, after
 * the gesture's own clamp) from `fromStartSec`: its place in both timings, or
 * null when the move changes nothing in the timing it was made in (a nudge
 * under the pause threshold, say) — so no step is recorded and nothing stored.
 *
 * `other` is the other timing's layout. Without one, the other place moves by
 * the same distance with no limits of its own.
 */
export function movedTakePlace(args: {
  here: TimelineLayout | null | undefined
  other: TimelineLayout | null | undefined
  track: readonly PlacedTake[]
  take: PlacedTake
  fromStartSec: number
  toStartSec: number
}): MovedTake | null {
  const here = args.here ?? FILE_CLOCK
  const { cell, audioId } = args.take
  const att = cell.attachments?.[audioId]
  const to = here.retimeAnchorSec(cell, att, args.toStartSec, audioId)
  const from = here.retimeAnchorSec(cell, att, args.fromStartSec, audioId)
  if (to == null || from == null) return null
  const hereMs = targetOffsetMsFor(cell, to)
  const deltaMs = hereMs - targetOffsetMsFor(cell, from)
  if (deltaMs === 0) return null
  const otherTiming: Timing = timingOf(here) === "source" ? "recordings" : "source"
  const other = args.other && timingOf(args.other) === otherTiming ? args.other : null
  const otherMs =
    (other ? placeAfterMoveMs(other, args.track, args.take, deltaMs / 1000) : null) ??
    placeNowMs(cell, audioId, otherTiming) + deltaMs
  return {
    anchorSec: to,
    place: otherTiming === "recordings"
      ? { targetOffsetMs: hereMs, recordingsOffsetMs: otherMs }
      : { targetOffsetMs: otherMs, recordingsOffsetMs: hereMs },
  }
}
