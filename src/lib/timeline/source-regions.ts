// The source-audio band: the linked video's own audio, drawn as ONE continuous
// span divided at the subtitle timestamps. (AQU-646)
//
// The Source row has always been fed the dialogue lane, which deriveLanes fills
// only from `medium: "media"` cells — and a VTT import makes none, so for a
// subtitle file timed against footage the row is simply blank. It is not
// broken; it has no data. This is the data.
//
// The regions are DERIVED, never stored: no schema change, no event kind, no
// migration. They are recomputed from the cells and the video's length the same
// way the lanes and the programme already are.
//
// Two things worth knowing about the shape:
//
//   - The stretches BETWEEN cues are regions too. That is the point of the
//     feature: the video has sound there, nobody has said anything about it
//     yet, and that is where captions for the hearing impaired go.
//
//   - It is a BOUNDARY SWEEP rather than a walk down sorted pairs, because real
//     subtitle files contain cues that overlap in time — two speakers at once.
//     A pairwise walk has to clip one of them or drop it, which moves a
//     timestamp the user can see in their own file. The sweep represents the
//     overlap honestly instead, as a stretch owned by two cells.
//
// Integer milliseconds throughout: the boundaries have to compare exactly, and
// cue times arrive as thousandths that do not survive float addition.

/** The minimum a cell must carry to take part. `CellData` satisfies it. */
export interface RegionSegment {
  id: string
  /** Seconds. Both present and end > start ⇒ the cell divides the band. */
  startTime?: number
  endTime?: number
}

export type SourceRegionKind = "cue" | "gap" | "overlap"

export interface SourceRegion {
  startSec: number
  endSec: number
  kind: SourceRegionKind
  /** Cells covering this stretch: none for a gap, one for a cue, two or more
   *  for an overlap. */
  cellIds: readonly string[]
}

export interface SourceRegionMap {
  /** Contiguous, ordered, covering [0, totalSec] with no holes and no overlaps. */
  regions: readonly SourceRegion[]
  /** The band's full extent — the footage's length, or the cells' if that is
   *  longer (a cue past the end of the video is still a cue). */
  totalSec: number
}

export const EMPTY_SOURCE_REGIONS: SourceRegionMap = { regions: [], totalSec: 0 }

const toMs = (sec: number): number => Math.round(sec * 1000)

interface TimedMs {
  id: string
  startMs: number
  endMs: number
}

function timedInMs(segments: readonly RegionSegment[]): TimedMs[] {
  const out: TimedMs[] = []
  for (const s of segments) {
    const { startTime, endTime } = s
    if (typeof startTime !== "number" || !Number.isFinite(startTime)) continue
    if (typeof endTime !== "number" || !Number.isFinite(endTime)) continue
    const startMs = toMs(Math.max(0, startTime))
    const endMs = toMs(Math.max(0, endTime))
    // A zero-length or inverted cue divides nothing. Dropping it here keeps the
    // sweep's event pairs balanced.
    if (endMs <= startMs) continue
    out.push({ id: s.id, startMs, endMs })
  }
  return out
}

/**
 * Build the band. `videoDurationSec` may be null — the element has not reported
 * yet, or cannot (Chromium and an HLS playlist) — in which case the band spans
 * the cells' own extent, which is exactly what the row showed before.
 */
export function deriveSourceRegions(
  segments: readonly RegionSegment[],
  videoDurationSec: number | null | undefined,
): SourceRegionMap {
  const timed = timedInMs(segments)
  const footageMs =
    videoDurationSec != null && Number.isFinite(videoDurationSec) && videoDurationSec > 0
      ? toMs(videoDurationSec)
      : 0
  let cellsEndMs = 0
  for (const t of timed) if (t.endMs > cellsEndMs) cellsEndMs = t.endMs
  const totalMs = Math.max(footageMs, cellsEndMs)
  if (totalMs <= 0) return EMPTY_SOURCE_REGIONS

  // One event per cue edge. Ends sort BEFORE starts at the same millisecond, so
  // a cue that finishes exactly where the next begins is a clean division and
  // not a zero-length overlap.
  const events: { at: number; delta: 1 | -1; id: string }[] = []
  for (const t of timed) {
    events.push({ at: t.startMs, delta: 1, id: t.id })
    events.push({ at: Math.min(t.endMs, totalMs), delta: -1, id: t.id })
  }
  events.sort((a, b) => a.at - b.at || a.delta - b.delta)

  const bounds = new Set<number>([0, totalMs])
  for (const e of events) if (e.at > 0 && e.at < totalMs) bounds.add(e.at)
  const boundaries = [...bounds].sort((a, b) => a - b)

  const regions: SourceRegion[] = []
  const active = new Set<string>()
  let ei = 0
  for (let i = 0; i < boundaries.length - 1; i++) {
    const a = boundaries[i]
    const b = boundaries[i + 1]
    while (ei < events.length && events[ei].at <= a) {
      const ev = events[ei++]
      if (ev.delta === 1) active.add(ev.id)
      else active.delete(ev.id)
    }
    if (b <= a) continue
    const cellIds = [...active]
    regions.push({
      startSec: a / 1000,
      endSec: b / 1000,
      kind: cellIds.length === 0 ? "gap" : cellIds.length === 1 ? "cue" : "overlap",
      cellIds,
    })
  }

  return { regions, totalSec: totalMs / 1000 }
}

/** The region containing `sec`. Null outside the band. */
export function findRegionAt(map: SourceRegionMap, sec: number): SourceRegion | null {
  if (!Number.isFinite(sec) || sec < 0 || sec > map.totalSec) return null
  let lo = 0
  let hi = map.regions.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const r = map.regions[mid]
    if (sec < r.startSec) hi = mid - 1
    else if (sec >= r.endSec) lo = mid + 1
    else return r
  }
  // Exactly on the band's right edge belongs to the last region.
  return map.regions.length > 0 && sec === map.totalSec ? map.regions[map.regions.length - 1] : null
}

/**
 * The stretch immediately AFTER this cell — what an "insert a line below"
 * gesture would claim.
 *
 * Deliberately keyed by cellId returning a region, never the reverse. A region
 * cannot hand back the cell to anchor a new row to: this list is ordered by
 * TIME, while `anchorCellId` needs the persisted CHAIN order, and the two
 * provably diverge the moment anyone drags a card past its neighbour
 * (cell.retime is non-chain-mutating). The insert point comes from the store.
 */
export function regionAfterCell(map: SourceRegionMap, cellId: string): SourceRegion | null {
  let lastOwned = -1
  for (let i = 0; i < map.regions.length; i++) {
    if (map.regions[i].cellIds.includes(cellId)) lastOwned = i
  }
  if (lastOwned < 0) return null
  return map.regions[lastOwned + 1] ?? null
}

/** The stretch immediately BEFORE this cell — what "insert above" would claim. */
export function regionBeforeCell(map: SourceRegionMap, cellId: string): SourceRegion | null {
  for (let i = 0; i < map.regions.length; i++) {
    if (map.regions[i].cellIds.includes(cellId)) return i > 0 ? map.regions[i - 1] : null
  }
  return null
}
