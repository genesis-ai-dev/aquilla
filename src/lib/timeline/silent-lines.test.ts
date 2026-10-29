// AQU-2251 (Sam, Oct 28): "Skip lines with nothing to play" when a file FOLLOWS
// ITS SOURCE.
//
// There the file's own clock runs, so a line is silent only where the file has
// no original audio and no film at that line — which is the built-in clock (a
// subtitle file with neither). With the setting on, playback jumps from the end
// of one line with something to hear to the start of the next one; the gaps
// between two lines that both have something to hear are left alone, because
// those are the file's own timing, not lines. Off, the clock runs across, as it
// always did.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook } from "@testing-library/react"
import type { CellData } from "@/hooks/useCells"
import { clockSoundMap, silentSkipTarget, useSkipSilentLinesOnVirtualClock } from "./silent-lines"
import {
  getVirtualClockSec,
  getVirtualClockPlaying,
  resetVirtualClockForTests,
  startVirtualClock,
  tickVirtualClock,
  virtualClockPlay,
  virtualClockSeek,
} from "./virtual-clock"
import { RECORDING_SLOT } from "./track-slots"
import { resetSkipSilentLinesPrefCacheForTests, setSkipSilentLinesPref } from "@/lib/store/skip-silent-lines-pref"

/** A subtitle cue with times; `takeMs` gives it a take that starts on the line. */
function cue(id: string, start: number, end: number, takeMs?: number, extra: Partial<CellData> = {}): CellData {
  const takeId = `audio-${id}-1700000000-take.webm`
  return {
    id,
    fileId: "f1",
    original: `${id} words`,
    translated: "",
    medium: "text",
    startTime: start,
    endTime: end,
    ...(takeMs != null ? { selectedAudioId: takeId } : {}),
    attachments:
      takeMs != null ? { [takeId]: { type: "audio", url: `http://audio.test/${id}.webm`, durationMs: takeMs } } : {},
    ...extra,
  } as unknown as CellData
}

const SLOTS = [RECORDING_SLOT]

describe("silentSkipTarget", () => {
  // c1 [0,2] recorded; c2 [2.5,4] and c3 [4.5,6] not; c4 [7,9] recorded. End 9.
  const map = clockSoundMap([cue("c1", 0, 2, 1_500), cue("c2", 2.5, 4), cue("c3", 4.5, 6), cue("c4", 7, 9, 2_000)], SLOTS)

  it("plays on while a line with something to hear is under the clock", () => {
    expect(silentSkipTarget(map, 0, 9)).toBeNull()
    expect(silentSkipTarget(map, 1.9, 9)).toBeNull()
    expect(silentSkipTarget(map, 7.5, 9)).toBeNull()
  })

  it("from the end of a line with something to hear, jumps to the start of the next one", () => {
    expect(silentSkipTarget(map, 2, 9)).toBe(7)
    expect(silentSkipTarget(map, 2.2, 9)).toBe(7)
  })

  it("on a line with nothing to hear, jumps to the next line with something to hear", () => {
    expect(silentSkipTarget(map, 3, 9)).toBe(7)
    expect(silentSkipTarget(map, 5, 9)).toBe(7)
    // Past the last silent line, the gap before the next line is the file's own.
    expect(silentSkipTarget(map, 6.5, 9)).toBeNull()
  })

  it("leaves the gap between two lines that both have something to hear alone", () => {
    const tight = clockSoundMap([cue("c1", 0, 2, 2_000), cue("c2", 3, 5, 2_000)], SLOTS)
    expect(silentSkipTarget(tight, 2.5, 5)).toBeNull()
  })

  it("after the last line with something to hear, runs out to the end", () => {
    const tail = clockSoundMap([cue("c1", 0, 2, 2_000), cue("c2", 3, 5)], SLOTS)
    expect(silentSkipTarget(tail, 2, 5)).toBe(5)
  })

  it("waits for a take that runs past its line to finish", () => {
    const long = clockSoundMap([cue("c1", 0, 2, 3_000), cue("c2", 2.5, 4), cue("c3", 5, 6, 1_000)], SLOTS)
    expect(silentSkipTarget(long, 2.6, 6)).toBeNull()
    expect(silentSkipTarget(long, 3, 6)).toBe(5)
  })

  it("counts a hidden line as having nothing to hear — its take never sounds", () => {
    const hidden = clockSoundMap([cue("c1", 0, 2, 2_000), cue("c2", 2, 4, 2_000, { hidden: true }), cue("c3", 4, 6, 2_000)], SLOTS)
    expect(silentSkipTarget(hidden, 2, 6)).toBe(4)
  })

  it("does nothing when no line on the clock is silent", () => {
    expect(clockSoundMap([cue("c1", 0, 2, 2_000)], SLOTS).silent).toHaveLength(0)
    expect(silentSkipTarget(clockSoundMap([cue("c1", 0, 2, 2_000)], SLOTS), 2.5, 3)).toBeNull()
  })
})

describe("useSkipSilentLinesOnVirtualClock — the built-in clock jumps the silent lines", () => {
  let now = 0
  const cells = [cue("c1", 0, 2, 1_500), cue("c2", 2.5, 4), cue("c3", 4.5, 6), cue("c4", 7, 9, 2_000)]
  /** Move the wall clock on and let the clock publish. */
  const advance = (sec: number) => act(() => {
    now += sec * 1000
    tickVirtualClock()
  })

  beforeEach(() => {
    now = 0
    vi.spyOn(performance, "now").mockImplementation(() => now)
    localStorage.removeItem("aq.skip-silent-lines.v1")
    resetSkipSilentLinesPrefCacheForTests()
    resetVirtualClockForTests()
    startVirtualClock(9)
  })
  afterEach(() => {
    resetVirtualClockForTests()
    vi.restoreAllMocks()
    localStorage.removeItem("aq.skip-silent-lines.v1")
    resetSkipSilentLinesPrefCacheForTests()
  })

  it("on (the default): at the end of a recorded line, the clock goes straight to the next recorded line", () => {
    renderHook(() => useSkipSilentLinesOnVirtualClock(cells, true))
    act(() => { virtualClockPlay() })
    advance(1)
    expect(getVirtualClockSec()).toBeCloseTo(1, 3)
    advance(1.05)
    expect(getVirtualClockSec()).toBeCloseTo(7, 3)
    expect(getVirtualClockPlaying()).toBe(true)
  })

  it("on: pressing play on a silent line starts at the next recorded line", () => {
    renderHook(() => useSkipSilentLinesOnVirtualClock(cells, true))
    act(() => { virtualClockSeek(3) })
    expect(getVirtualClockSec()).toBeCloseTo(3, 3) // a seek while stopped lands where it was asked
    act(() => { virtualClockPlay() })
    expect(getVirtualClockSec()).toBeCloseTo(7, 3)
  })

  it("on: trailing silent lines run the clock out to its end", () => {
    const tail = [cue("c1", 0, 2, 2_000), cue("c2", 3, 9)]
    renderHook(() => useSkipSilentLinesOnVirtualClock(tail, true))
    act(() => { virtualClockPlay() })
    advance(2.05)
    advance(0.05)
    expect(getVirtualClockSec()).toBeCloseTo(9, 3)
    expect(getVirtualClockPlaying()).toBe(false)
  })

  it("off: the clock runs across the silent lines, as it always did", () => {
    setSkipSilentLinesPref(false)
    renderHook(() => useSkipSilentLinesOnVirtualClock(cells, true))
    act(() => { virtualClockPlay() })
    advance(2.05)
    expect(getVirtualClockSec()).toBeCloseTo(2.05, 3)
    advance(1)
    expect(getVirtualClockSec()).toBeCloseTo(3.05, 3)
  })

  it("does nothing while the built-in clock is not this file's transport", () => {
    renderHook(() => useSkipSilentLinesOnVirtualClock(cells, false))
    act(() => { virtualClockPlay() })
    advance(2.05)
    expect(getVirtualClockSec()).toBeCloseTo(2.05, 3)
  })
})
