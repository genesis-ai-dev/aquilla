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
import { clockSoundMap, silentSkipTarget, skipSilentLinesCanChange, useSkipSilentLinesOnVirtualClock } from "./silent-lines"
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

  // AQU-2251 (Sam, Oct 29): "A hidden line should always be skipped. Always."
  describe("with the setting off", () => {
    // c1 [0,2] recorded; c2 [2,4] hidden; c3 [4,6] not recorded; c4 [7,9] recorded. End 9.
    const offMap = clockSoundMap(
      [cue("c1", 0, 2, 2_000), cue("c2", 2, 4, 2_000, { hidden: true }), cue("c3", 4, 6), cue("c4", 7, 9, 2_000)],
      SLOTS,
    )

    it("still jumps a hidden line, to the next line it plays", () => {
      expect(silentSkipTarget(offMap, 2, 9, false)).toBe(4)
      expect(silentSkipTarget(offMap, 3, 9, false)).toBe(4)
    })

    it("plays an unrecorded line through, and the file's own gap after it", () => {
      expect(silentSkipTarget(offMap, 4, 9, false)).toBeNull()
      expect(silentSkipTarget(offMap, 5.5, 9, false)).toBeNull()
      expect(silentSkipTarget(offMap, 6.5, 9, false)).toBeNull()
    })

    it("runs out to the end over trailing hidden lines", () => {
      const tail = clockSoundMap([cue("c1", 0, 2, 2_000), cue("c2", 3, 5, undefined, { hidden: true })], SLOTS)
      expect(silentSkipTarget(tail, 2, 5, false)).toBe(5)
    })
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

  // AQU-2251 (Sam, Oct 29): "A hidden line should always be skipped. Always."
  it("off: the clock still jumps a hidden line, and runs across the unrecorded one after it", () => {
    setSkipSilentLinesPref(false)
    const withHidden = [cue("c1", 0, 2, 2_000), cue("c2", 2, 4, 2_000, { hidden: true }), cue("c3", 4, 6), cue("c4", 7, 9, 2_000)]
    renderHook(() => useSkipSilentLinesOnVirtualClock(withHidden, true))
    act(() => { virtualClockPlay() })
    advance(2.05)
    expect(getVirtualClockSec()).toBeCloseTo(4, 3)
    expect(getVirtualClockPlaying()).toBe(true)
    advance(1)
    expect(getVirtualClockSec()).toBeCloseTo(5, 3)
    advance(1.5)
    expect(getVirtualClockSec()).toBeCloseTo(6.5, 3)
  })

  it("on: the clock jumps a hidden line as it does an unrecorded one", () => {
    const withHidden = [cue("c1", 0, 2, 2_000), cue("c2", 2, 4, 2_000, { hidden: true }), cue("c3", 4, 6), cue("c4", 7, 9, 2_000)]
    renderHook(() => useSkipSilentLinesOnVirtualClock(withHidden, true))
    act(() => { virtualClockPlay() })
    advance(2.05)
    expect(getVirtualClockSec()).toBeCloseTo(7, 3)
  })

  it("does nothing while the built-in clock is not this file's transport", () => {
    renderHook(() => useSkipSilentLinesOnVirtualClock(cells, false))
    act(() => { virtualClockPlay() })
    advance(2.05)
    expect(getVirtualClockSec()).toBeCloseTo(2.05, 3)
  })
})

// AQU-2251: the setting's row in the timeline's ⋯ is shown only where it can
// change something — the open file, under its current timing, has a line with
// nothing to play that is not hidden (a hidden line is skipped either way).
describe("skipSilentLinesCanChange", () => {
  const SOURCE_ID = "audio-f1-1690000000-shared.mp3"
  /** A section of an imported recording: its original always sounds. */
  const section = (id: string, start: number, end: number): CellData =>
    ({
      id,
      fileId: "f1",
      original: "",
      translated: "",
      medium: "media",
      startTime: start,
      endTime: end,
      attachments: { [SOURCE_ID]: { type: "audio", url: "frontier-audio://src" } },
    }) as unknown as CellData

  describe("following the recordings", () => {
    const followingRecordings = (...runs: CellData[][]) =>
      skipSilentLinesCanChange({ timing: "audioFirst", runs, clockCells: null, slots: SLOTS })

    it("no: every line has a take", () => {
      expect(followingRecordings([cue("c1", 0, 2, 2_000), cue("c2", 2, 4, 1_500)])).toBe(false)
    })

    it("no: every line has its original audio, recorded or not", () => {
      expect(followingRecordings([section("s1", 0, 3), section("s2", 3, 6)])).toBe(false)
    })

    it("yes: a line has neither a take nor an original", () => {
      expect(followingRecordings([cue("c1", 0, 2, 2_000), cue("c2", 2, 4)])).toBe(true)
    })

    it("no: the only lines with nothing to play are hidden — they are skipped either way", () => {
      expect(followingRecordings([cue("c1", 0, 2, 2_000), cue("c2", 2, 4, undefined, { hidden: true })])).toBe(false)
      expect(followingRecordings([cue("c1", 0, 2, 2_000), cue("c2", 2, 4, 2_000, { hidden: true })])).toBe(false)
    })

    it("yes: one chapter of a book is all recorded and another is not", () => {
      expect(followingRecordings([cue("c1", 0, 2, 2_000)], [cue("c2", 0, 2), cue("c3", 2, 4, 2_000)])).toBe(true)
    })
  })

  describe("following the source", () => {
    it("no: a film or a source recording drives the file, so every line is heard", () => {
      expect(
        skipSilentLinesCanChange({ timing: "dubbing", runs: [[cue("c1", 0, 2)]], clockCells: null, slots: SLOTS }),
      ).toBe(false)
    })

    it("on the built-in clock: no when every line has a take, yes when one has none", () => {
      const onClock = (cells: CellData[]) =>
        skipSilentLinesCanChange({ timing: "dubbing", runs: [cells], clockCells: cells, slots: SLOTS })
      expect(onClock([cue("c1", 0, 2, 2_000), cue("c2", 3, 5, 2_000)])).toBe(false)
      expect(onClock([cue("c1", 0, 2, 2_000), cue("c2", 3, 5)])).toBe(true)
      expect(onClock([cue("c1", 0, 2, 2_000), cue("c2", 3, 5, undefined, { hidden: true })])).toBe(false)
    })
  })
})
