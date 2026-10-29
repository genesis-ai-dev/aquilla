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
// "Something to hear" is exactly what the dub driver would sound on this
// clock — a take on any target track, not on a hidden line — and the span it
// covers is the line's own joined with its takes', so a take that runs past
// its line is never cut off by a jump.

import { useEffect, useMemo } from "react"
import type { CellData } from "@/hooks/useCells"
import { resolveTargetPieces } from "@/lib/audio/track-audio"
import { getQueueTargetSlots } from "@/lib/audio/play-queue"
import { isHiddenCell } from "@/lib/cells/hidden"
import { useSkipSilentLinesPref } from "@/lib/store/skip-silent-lines-pref"
import { targetChipGeom } from "./lane-timing"
import { isDefaultTrackSlot } from "./track-slots"
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
  /** Each line with nothing to hear. By start. */
  silent: ClockSpan[]
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
  for (const cell of cells) {
    const span = lineSpan(cell)
    if (!span) continue
    // Sam's decision (hidden lines): a hidden line's takes never sound.
    const pieces = isHiddenCell(cell)
      ? []
      : slots.flatMap((slot) => resolveTargetPieces(cell, isDefaultTrackSlot(slot) ? undefined : slot))
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
  return { sounding, silent }
}

/**
 * Where the clock should jump to from `sec`, or null to play on: the start of
 * the next line with something to hear (or `endSec` when there is none) —
 * but only when nothing sounds at `sec` and a line with nothing to hear lies
 * between here and there.
 */
export function silentSkipTarget(map: ClockSoundMap, sec: number, endSec: number): number | null {
  if (!Number.isFinite(sec)) return null
  let next: number | null = null
  for (const s of map.sounding) {
    if (sec >= s.start && sec < s.end) return null // something sounds here
    if (s.start > sec && (next == null || s.start < next)) next = s.start
  }
  const until = next ?? endSec
  if (!(until - sec >= MIN_JUMP_SEC)) return null
  const silentLineAhead = map.silent.some((l) => l.end > sec && l.start < until)
  return silentLineAhead ? until : null
}

/**
 * Drive the jumps on the built-in clock while it is this file's transport
 * (`active`) and running, with the setting on. Handed the same cells the dub
 * driver plays from, so the two agree about what sounds.
 */
export function useSkipSilentLinesOnVirtualClock(cells: readonly CellData[], active: boolean): void {
  const skip = useSkipSilentLinesPref()
  const sec = useVirtualClockSec()
  const playing = useVirtualClockPlaying()
  const durationSec = useVirtualClockDuration()
  const map = useMemo(
    () => (active && skip ? clockSoundMap(cells, getQueueTargetSlots()) : null),
    [active, skip, cells],
  )
  useEffect(() => {
    if (!map || !playing || sec == null) return
    const to = silentSkipTarget(map, sec, durationSec)
    if (to != null) virtualClockSeek(to)
  }, [map, playing, sec, durationSec])
}
