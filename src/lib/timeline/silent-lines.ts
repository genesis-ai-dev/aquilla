// AQU-2251 (Sam, Oct 28): "Skip lines with nothing to play", when a file
// FOLLOWS ITS SOURCE.
//
// Following the recordings, the play queue steps over (or, with the setting
// off, plays through) a line with nothing to hear — see play-queue's
// `progPlaysThroughSilence`. Following the source is different: playback runs
// on the FILE's clock, so a line is only ever silent where the file has no
// original audio and no film at that line. A source recording or a film runs
// under every line and is heard there, so the only clock that crosses silent
// lines is the built-in one (lib/timeline/virtual-clock): a subtitle file with
// neither, where a line sounds only if it has a take.
//
// With the setting on, that clock jumps from the end of one line with
// something to hear to the start of the next one. Only LINES are skipped: the
// gap between two lines that both have something to hear is the file's own
// timing, and is left alone. With the setting off the clock runs across them,
// as it always did.
//
// A HIDDEN line is jumped either way. Sam's rule for hidden lines (Oct 29):
// following the recordings, and on this built-in clock, a hidden line is
// skipped and the playhead jumps it. Following the source on a file with a
// film or source audio it is NOT jumped — the film and its own sound play on
// across it, only its takes stay silent, as skipping it would cut real time
// out of the show — and there this clock is not the transport, so nothing here
// runs. With the setting off, the clock runs across an unrecorded line as if
// it sounded, and jumps only the hidden lines, to the next line it plays.
//
// "Something to hear" is exactly what the dub driver would sound on this
// clock — a take on any target track, not on a hidden line — and the span it
// covers is the line's own joined with its takes', so a take that runs past
// its line is never cut off by a jump.

import { useEffect } from "react"
import type { CellData } from "@/hooks/useCells"
import { resolveTargetPieces } from "@/lib/audio/track-audio"
import { isHiddenCell } from "@/lib/cells/hidden"
import type { AudioTimingMode } from "@/lib/parsers/types"
import { useSkipSilentLinesPref } from "@/lib/store/skip-silent-lines-pref"
import { targetChipGeom } from "./lane-timing"
import { playedProgramme, slotHasNothingToPlay } from "./programme"
import { isDefaultTrackSlot, RECORDING_SLOT } from "./track-slots"
import { setVirtualClockJumps, type ClockJump } from "./virtual-clock"

export interface ClockSpan {
  start: number
  end: number
}

/** Where on the clock something sounds, and where the lines with nothing to hear are. */
export interface ClockSoundMap {
  /** Each line with something to hear: its span joined with its takes'. By start. */
  sounding: ClockSpan[]
  /** Each line with nothing to hear that is not hidden — the lines the setting
   *  decides about. By start. */
  silent: ClockSpan[]
  /** Each hidden line: nothing to hear (its takes never sound), and jumped
   *  whichever way the setting is. By start. */
  hidden: ClockSpan[]
}

function lineSpan(cell: CellData): ClockSpan | null {
  const { startTime, endTime } = cell
  if (typeof startTime !== "number" || !Number.isFinite(startTime)) return null
  if (typeof endTime !== "number" || !Number.isFinite(endTime) || endTime <= startTime) return null
  return { start: startTime, end: endTime }
}

/** Map a file's timed lines for `clockJumps`, over the tracks that sound (`slots`). */
export function clockSoundMap(cells: readonly CellData[], slots: readonly string[]): ClockSoundMap {
  const sounding: ClockSpan[] = []
  const silent: ClockSpan[] = []
  const hidden: ClockSpan[] = []
  for (const cell of cells) {
    const span = lineSpan(cell)
    if (!span) continue
    // Sam's decision (hidden lines): a hidden line's takes never sound.
    if (isHiddenCell(cell)) {
      hidden.push(span)
      continue
    }
    const pieces = slots.flatMap((slot) => resolveTargetPieces(cell, isDefaultTrackSlot(slot) ? undefined : slot))
    if (pieces.length === 0) {
      silent.push(span)
      continue
    }
    let { start, end } = span
    for (const piece of pieces) {
      const geom = targetChipGeom(cell, cell.attachments?.[piece.audioId])
      if (!geom) continue
      start = Math.min(start, geom.start)
      end = Math.max(end, geom.end)
    }
    sounding.push({ start, end })
  }
  sounding.sort((a, b) => a.start - b.start)
  silent.sort((a, b) => a.start - b.start)
  hidden.sort((a, b) => a.start - b.start)
  return { sounding, silent, hidden }
}

/**
 * The stretches the clock jumps, for `setVirtualClockJumps`. With
 * `skipSilent` (the setting, on by default) it plays the lines with something
 * to hear and skips the rest; off, it plays every line but a hidden one. In
 * the gap between two lines it plays, it jumps to the next one from anywhere
 * up to the end of the last line it skips there — so a seek past that line
 * plays the file's own gap — and after the last line it plays, it runs out to
 * the end.
 */
export function clockJumps(map: ClockSoundMap, skipSilent = true): ClockJump[] {
  const played = joined(skipSilent ? map.sounding : [...map.sounding, ...map.silent])
  const skipped = skipSilent ? [...map.silent, ...map.hidden] : map.hidden
  // Gap k runs from the end of played line k-1 to the start of played line k;
  // the first opens at -Infinity and the last closes at the end (Infinity).
  const gapFrom = (k: number) => (k === 0 ? -Infinity : played[k - 1].end)
  const gapTo = (k: number) => (k < played.length ? played[k].start : Infinity)
  /** How far into each gap the lines it skips reach. */
  const reach = new Array<number>(played.length + 1).fill(-Infinity)
  for (const line of skipped) {
    for (let k = playedStartingBy(played, line.start); k <= played.length && gapFrom(k) < line.end; k++) {
      reach[k] = Math.max(reach[k], line.end)
    }
  }
  const jumps: ClockJump[] = []
  for (let k = 0; k <= played.length; k++) {
    const end = Math.min(reach[k], gapTo(k))
    if (end > gapFrom(k)) jumps.push({ start: gapFrom(k), end, to: gapTo(k) })
  }
  return jumps
}

/** Overlapping (or touching) spans joined into one. By start. */
function joined(spans: readonly ClockSpan[]): ClockSpan[] {
  const out: ClockSpan[] = []
  for (const s of [...spans].sort((a, b) => a.start - b.start)) {
    const last = out[out.length - 1]
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end)
    else out.push({ ...s })
  }
  return out
}

/** How many of the played spans start at or before `sec` — the gap a line starting there opens into. */
function playedStartingBy(played: readonly ClockSpan[], sec: number): number {
  let lo = 0
  let hi = played.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (played[mid].start <= sec) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** What decides whether "Skip lines with nothing to play" can change anything on a file. */
export interface SkipSilentLinesScope {
  timing: AudioTimingMode
  /** Following the recordings: the lines the queue lays out and plays, one
   *  list per run it plays — a book's chapters, or the whole file. */
  runs: readonly (readonly CellData[])[]
  /** Following the source: the cells the built-in clock's takes play from,
   *  while that clock is the file's transport. Null while a film or a source
   *  recording drives the file — then something is heard under every line. */
  clockCells: readonly CellData[] | null
  /** The target tracks that sound (the queue's target slots). */
  slots: readonly string[]
}

/**
 * AQU-2251 (Sam, Oct 29): can the setting change anything on this file, under
 * its current timing? Only when a line has nothing to play and is not hidden
 * (a hidden line is skipped either way). Following the recordings, that is a
 * verse of the programme as the queue plays it with no original and no take;
 * following the source, a line on the built-in clock with no take. With a
 * take or original audio on every line, or a film driving the file, there is
 * nothing to skip, and the timeline's ⋯ leaves the row out.
 */
export function skipSilentLinesCanChange(scope: SkipSilentLinesScope): boolean {
  if (scope.timing === "audioFirst") {
    return scope.runs.some((cells) => {
      const played = playedProgramme(cells)
      return played != null && played.programme.slots.some((slot) => slotHasNothingToPlay(slot, played.hiddenCellIds))
    })
  }
  if (!scope.clockCells) return false
  return clockSoundMap(scope.clockCells, soundingSlots(scope.slots)).silent.length > 0
}

/** The queue's own fallback: no track listed means the recording track. */
function soundingSlots(slots: readonly string[]): readonly string[] {
  return slots.length > 0 ? slots : [RECORDING_SLOT]
}

/**
 * Hand the built-in clock its jumps while it is this file's transport
 * (`active`): every line with nothing to hear with the setting on, only the
 * hidden lines with it off. Handed the same cells the dub driver plays from,
 * and the same target tracks (`slots`) the workspace hands the queue — never
 * the queue's own copy, which the workspace publishes only after it renders —
 * so the two agree about what sounds. The clock walks them itself
 * (`setVirtualClockJumps`), so nothing here runs on its beats.
 */
export function useSkipSilentLinesOnVirtualClock(
  cells: readonly CellData[],
  slots: readonly string[],
  active: boolean,
): void {
  const skip = useSkipSilentLinesPref()
  useEffect(() => {
    if (!active) return
    setVirtualClockJumps(clockJumps(clockSoundMap(cells, soundingSlots(slots)), skip))
    return () => setVirtualClockJumps(null)
  }, [active, skip, cells, slots])
}
