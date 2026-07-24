// Timeline-segment-model (Scope A) — pure, read-time helpers.
//
// Nothing here is persisted. `orderedBy` is a display lens: these functions
// derive ordering, timeline bounds, and segment overlap from whatever data a
// segment happens to carry. Timing is never synthesized — a segment with no
// timing is simply ordered by its `sequenceIndex` (its "home" position).

import type { OrderedBy } from "@/lib/parsers/types"
import type { SegmentMedium } from "@/lib/sync/cells-read-types"

/** Minimal shape these helpers need. `CellData` satisfies it structurally. */
export interface TimelineSegment {
  /** seconds; both present ⇒ the segment is "timed". */
  startTime?: number
  endTime?: number
  /** intrinsic order key; fractional values allowed (see `sequenceBetween`). */
  sequenceIndex?: number
  medium?: SegmentMedium
  /** AQU-646: text carried by media sections — drives the subtitle-lane
   *  mirror (translation once translated, transcript before that). */
  transcription?: string
  translated?: string
}

/** A segment is "timed" only when it has a usable start AND end. */
export function hasTiming(seg: TimelineSegment): boolean {
  return (
    typeof seg.startTime === "number" &&
    Number.isFinite(seg.startTime) &&
    typeof seg.endTime === "number" &&
    Number.isFinite(seg.endTime)
  )
}

export interface TimelineBounds {
  /** earliest start across timed segments (seconds). */
  start: number
  /** latest end across timed segments (seconds). */
  end: number
}

/**
 * Fullest range that accommodates every timed segment: min(start) → max(end).
 * Returns null when no segment has timing (so the time lens can show the
 * "none of your cells have timing" state).
 */
export function timelineBounds(segments: readonly TimelineSegment[]): TimelineBounds | null {
  let start = Infinity
  let end = -Infinity
  for (const s of segments) {
    if (!hasTiming(s)) continue
    if (s.startTime! < start) start = s.startTime!
    if (s.endTime! > end) end = s.endTime!
  }
  return start === Infinity ? null : { start, end }
}

/** Half-open interval overlap: [aStart,aEnd) intersects [bStart,bEnd). */
export function rangesOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd
}

export interface OverlapOptions {
  /** When set, only segments of this medium count (e.g. find overlapping text). */
  medium?: SegmentMedium
}

/**
 * Segments that overlap `target` in time. Advisory association — recomputed on
 * every call, never stored. `target` itself is excluded by reference identity.
 * Untimed segments (and an untimed target) never overlap anything.
 */
export function overlapsOf<T extends TimelineSegment>(
  target: TimelineSegment,
  segments: readonly T[],
  opts: OverlapOptions = {}
): T[] {
  if (!hasTiming(target)) return []
  const out: T[] = []
  for (const s of segments) {
    if (s === (target as unknown as T)) continue
    if (!hasTiming(s)) continue
    if (opts.medium && (s.medium ?? "text") !== opts.medium) continue
    if (rangesOverlap(target.startTime!, target.endTime!, s.startTime!, s.endTime!)) out.push(s)
  }
  return out
}

/**
 * Order segments for a display lens. Returns a NEW array; never mutates input
 * and never alters segment data.
 *
 * - `'sequence'`: by `sequenceIndex` (absent ⇒ original index), stable.
 * - `'time'`: timed segments by `startTime`; untimed segments keep their
 *   sequence "home" — they ride immediately after their nearest preceding
 *   timed neighbor (carry-forward), so an untimed row stays between the timed
 *   rows that bracket it. Leading untimed rows sort to the front in sequence
 *   order. Ties break by original index for stability.
 */
export function sortByLens<T extends TimelineSegment>(segments: readonly T[], orderedBy: OrderedBy): T[] {
  const indexed = segments.map((seg, i) => ({ seg, i }))

  if (orderedBy === "sequence") {
    return indexed
      .sort((a, b) => seqKey(a.seg, a.i) - seqKey(b.seg, b.i) || a.i - b.i)
      .map((x) => x.seg)
  }

  // time lens: first establish the sequence baseline, then carry forward the
  // last seen timed start so untimed rows home next to their neighbor.
  const baseline = indexed.slice().sort((a, b) => seqKey(a.seg, a.i) - seqKey(b.seg, b.i) || a.i - b.i)
  const effStart = new Map<number, number>()
  let carry = -Infinity
  for (const { seg, i } of baseline) {
    if (hasTiming(seg)) carry = seg.startTime!
    effStart.set(i, hasTiming(seg) ? seg.startTime! : carry)
  }
  return indexed
    .sort((a, b) => {
      const ea = effStart.get(a.i)!
      const eb = effStart.get(b.i)!
      if (ea !== eb) return ea - eb
      // same effective start: timed before the untimed rows hanging off it,
      // then stable by sequence baseline.
      const ta = hasTiming(a.seg) ? 0 : 1
      const tb = hasTiming(b.seg) ? 0 : 1
      if (ta !== tb) return ta - tb
      return seqKey(a.seg, a.i) - seqKey(b.seg, b.i) || a.i - b.i
    })
    .map((x) => x.seg)
}

function seqKey(seg: TimelineSegment, fallbackIndex: number): number {
  return typeof seg.sequenceIndex === "number" && Number.isFinite(seg.sequenceIndex)
    ? seg.sequenceIndex
    : fallbackIndex
}

/**
 * Fractional rank for inserting a segment between two neighbors (either may be
 * absent at the ends). Lets a new audio-only row land between sequence #5 and
 * #6 without renumbering. Repeated tight inserts eventually exhaust float
 * precision — acceptable for Scope A; a renumber pass is the Part-B remedy.
 */
export function sequenceBetween(before?: number, after?: number): number {
  if (before != null && after != null) return (before + after) / 2
  if (before != null) return before + 1
  if (after != null) return after - 1
  return 0
}
