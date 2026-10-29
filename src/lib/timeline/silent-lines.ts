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
// A HIDDEN line is jumped either way (Sam, Oct 29: "A hidden line should
// always be skipped. Always. No matter what."). With the setting off, the
// clock runs across an unrecorded line as if it sounded, and jumps only the
// hidden lines, to the next line it plays.
//
// "Something to hear" is exactly what the dub driver would sound on this
// clock — a take on any target track, not on a hidden line — and the span it
// covers is the line's own joined with its takes', so a take that runs past
// its line is never cut off by a jump.

import { useEffect, useMemo } from "react"
import type { CellData } from "@/hooks/useCells"
import { resolveTargetPieces } from "@/lib/audio/track-audio"
import { getQueueTargetSlots } from "@/lib/audio/play-queue"
import { isHiddenCell } from "@/lib/cells/hidden"
import type { AudioTimingMode } from "@/lib/parsers/types"
import { useSkipSilentLinesPref } from "@/lib/store/skip-silent-lines-pref"
import { targetChipGeom } from "./lane-timing"
import { playedProgramme, slotHasNothingToPlay } from "./programme"
import { isDefaultTrackSlot, RECORDING_SLOT } from "./track-slots"
import {
  useVirtualClockDuration,
  useVirtualClockPlaying,
  useVirtualClockSec,
  virtualClockSeek,
} from "./virtual-clock"

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

/** A jump shorter than this is no jump — the clock is already there. */
const MIN_JUMP_SEC = 0.01

function lineSpan(cell: CellData): ClockSpan | null {
  const { startTime, endTime } = cell
  if (typeof startTime !== "number" || !Number.isFinite(startTime)) return null
  if (typeof endTime !== "number" || !Number.isFinite(endTime) || endTime <= startTime) return null
  return { start: startTime, end: endTime }
}

/** Map a file's timed lines for `silentSkipTarget`, over the tracks that sound (`slots`). */
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
 * Where the clock should jump to from `sec`, or null to play on: the start of
 * the next line it plays (or `endSec` when there is none) — but only when no
 * line it plays is under `sec` and a line it skips lies between here and
 * there. With `skipSilent` (the setting, on by default) it plays the lines
 * with something to hear and skips the rest; off, it plays every line but a
 * hidden one.
 */
export function silentSkipTarget(map: ClockSoundMap, sec: number, endSec: number, skipSilent = true): number | null {
  if (!Number.isFinite(sec)) return null
  const played = skipSilent ? map.sounding : [...map.sounding, ...map.silent]
  const skipped = skipSilent ? [...map.silent, ...map.hidden] : map.hidden
  let next: number | null = null
  for (const s of played) {
    if (sec >= s.start && sec < s.end) return null // a line it plays is here
    if (s.start > sec && (next == null || s.start < next)) next = s.start
  }
  const until = next ?? endSec
  if (!(until - sec >= MIN_JUMP_SEC)) return null
  const skippedLineAhead = skipped.some((l) => l.end > sec && l.start < until)
  return skippedLineAhead ? until : null
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
  // The queue's own fallback: no track listed means the recording track.
  const slots = scope.slots.length > 0 ? scope.slots : [RECORDING_SLOT]
  return clockSoundMap(scope.clockCells, slots).silent.length > 0
}

/**
 * Drive the jumps on the built-in clock while it is this file's transport
 * (`active`) and running: every line with nothing to hear with the setting
 * on, only the hidden lines with it off. Handed the same cells the dub driver
 * plays from, so the two agree about what sounds.
 */
export function useSkipSilentLinesOnVirtualClock(cells: readonly CellData[], active: boolean): void {
  const skip = useSkipSilentLinesPref()
  const sec = useVirtualClockSec()
  const playing = useVirtualClockPlaying()
  const durationSec = useVirtualClockDuration()
  const map = useMemo(() => {
    if (!active) return null
    const m = clockSoundMap(cells, getQueueTargetSlots())
    // Off, and no hidden line on the clock: nothing to jump.
    return skip || m.hidden.length > 0 ? m : null
  }, [active, skip, cells])
  useEffect(() => {
    if (!map || !playing || sec == null) return
    const to = silentSkipTarget(map, sec, durationSec, skip)
    if (to != null) virtualClockSeek(to)
  }, [map, playing, sec, durationSec, skip])
}
