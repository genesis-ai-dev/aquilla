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
import { clockJumps, clockSoundMap, skipSilentLinesCanChange, useSkipSilentLinesOnVirtualClock, type ClockSoundMap } from "./silent-lines"
import {
  getVirtualClockSec,
  useVirtualClockSec,
  getVirtualClockPlaying,
  resetVirtualClockForTests,
  startVirtualClock,
  tickVirtualClock,
  virtualClockPlay,
  virtualClockSeek,
} from "./virtual-clock"
import { RECORDING_SLOT } from "./track-slots"
import { setQueueTargetSlots } from "@/lib/audio/play-queue"
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

/** Where a clock at `sec` jumps to straight away over `map`'s jumps, or null when it plays on. */
function silentSkipTarget(map: ClockSoundMap, sec: number, endSec: number, skipSilent = true): number | null {
  const jump = clockJumps(map, skipSilent).find((j) => sec >= j.start && sec < j.end)
  return jump ? (Number.isFinite(jump.to) ? jump.to : endSec) : null
}

describe("clockJumps — where the clock jumps from each position", () => {
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

  // AQU-2251 (Sam, Oct 29): on the built-in clock a hidden line is skipped,
  // whichever way the setting is.
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
    renderHook(() => useSkipSilentLinesOnVirtualClock(cells, SLOTS, true))
    act(() => { virtualClockPlay() })
    advance(1)
    expect(getVirtualClockSec()).toBeCloseTo(1, 3)
    advance(1.05)
    // 0.05 s past c1's end on this beat, and that 0.05 s is played in c4: the
    // silence between is skipped, not sat through.
    expect(getVirtualClockSec()).toBeCloseTo(7.05, 3)
    expect(getVirtualClockPlaying()).toBe(true)
  })

  it("on: pressing play on a silent line starts at the next recorded line", () => {
    renderHook(() => useSkipSilentLinesOnVirtualClock(cells, SLOTS, true))
    act(() => { virtualClockSeek(3) })
    expect(getVirtualClockSec()).toBeCloseTo(3, 3) // a seek while stopped lands where it was asked
    act(() => { virtualClockPlay() })
    expect(getVirtualClockSec()).toBeCloseTo(7, 3)
  })

  it("on: trailing silent lines run the clock out to its end", () => {
    const tail = [cue("c1", 0, 2, 2_000), cue("c2", 3, 9)]
    renderHook(() => useSkipSilentLinesOnVirtualClock(tail, SLOTS, true))
    act(() => { virtualClockPlay() })
    advance(2.05)
    advance(0.05)
    expect(getVirtualClockSec()).toBeCloseTo(9, 3)
    expect(getVirtualClockPlaying()).toBe(false)
  })

  it("off: the clock runs across the silent lines, as it always did", () => {
    setSkipSilentLinesPref(false)
    renderHook(() => useSkipSilentLinesOnVirtualClock(cells, SLOTS, true))
    act(() => { virtualClockPlay() })
    advance(2.05)
    expect(getVirtualClockSec()).toBeCloseTo(2.05, 3)
    advance(1)
    expect(getVirtualClockSec()).toBeCloseTo(3.05, 3)
  })

  // AQU-2251 (Sam, Oct 29): on the built-in clock a hidden line is skipped,
  // whichever way the setting is.
  it("off: the clock still jumps a hidden line, and runs across the unrecorded one after it", () => {
    setSkipSilentLinesPref(false)
    const withHidden = [cue("c1", 0, 2, 2_000), cue("c2", 2, 4, 2_000, { hidden: true }), cue("c3", 4, 6), cue("c4", 7, 9, 2_000)]
    renderHook(() => useSkipSilentLinesOnVirtualClock(withHidden, SLOTS, true))
    act(() => { virtualClockPlay() })
    advance(2.05)
    expect(getVirtualClockSec()).toBeCloseTo(4.05, 3)
    expect(getVirtualClockPlaying()).toBe(true)
    advance(1)
    expect(getVirtualClockSec()).toBeCloseTo(5.05, 3)
    advance(1.5)
    expect(getVirtualClockSec()).toBeCloseTo(6.55, 3)
  })

  it("on: the clock jumps a hidden line as it does an unrecorded one", () => {
    const withHidden = [cue("c1", 0, 2, 2_000), cue("c2", 2, 4, 2_000, { hidden: true }), cue("c3", 4, 6), cue("c4", 7, 9, 2_000)]
    renderHook(() => useSkipSilentLinesOnVirtualClock(withHidden, SLOTS, true))
    act(() => { virtualClockPlay() })
    advance(2.05)
    expect(getVirtualClockSec()).toBeCloseTo(7.05, 3)
  })

  // AQU-2251 (Sam, Oct 29): following the source on a file with a film or a
  // source recording, the built-in clock is not the transport, so nothing
  // jumps — a hidden line there is passed through, whichever way the setting is.
  it.each([
    ["on", true],
    ["off", false],
  ])("does not jump a hidden line while a film or a recording drives the file (the setting %s)", (_label, on) => {
    setSkipSilentLinesPref(on)
    const withHidden = [cue("c1", 0, 2, 2_000), cue("c2", 2, 4, 2_000, { hidden: true }), cue("c3", 4, 6, 2_000)]
    renderHook(() => useSkipSilentLinesOnVirtualClock(withHidden, SLOTS, false))
    act(() => { virtualClockPlay() })
    advance(2.05)
    expect(getVirtualClockSec()).toBeCloseTo(2.05, 3)
    advance(1)
    expect(getVirtualClockSec()).toBeCloseTo(3.05, 3)
  })

  // Review finding (Oct 29): the hook read the queue's track list itself, so a
  // track added while the file was open — or the last file's tracks, right
  // after a switch, before the workspace publishes the new ones — decided what
  // was silent. It is handed the same tracks the workspace hands the queue.
  it("hears a take on a track added while the file is open, and does not jump its line", () => {
    const B = "0192a7e0-0000-7000-8000-00000000000b"
    const onB = cue("c2", 2.5, 4, undefined, {
      selectedBySlot: { [B]: "audio-c2-b" },
      attachments: { "audio-c2-b": { type: "audio", url: "http://audio.test/c2b.webm", durationMs: 1_500 } },
    } as Partial<CellData>)
    const lines = [cue("c1", 0, 2, 2_000), onB, cue("c3", 4.5, 6, 1_500)]
    setQueueTargetSlots([RECORDING_SLOT])
    const { rerender } = renderHook(({ slots }) => useSkipSilentLinesOnVirtualClock(lines, slots, true), {
      initialProps: { slots: [RECORDING_SLOT] as readonly string[] },
    })
    // Track B is added: the workspace renders with the new list, and only
    // then publishes it to the queue, from an effect.
    rerender({ slots: [RECORDING_SLOT, B] })
    act(() => { setQueueTargetSlots([RECORDING_SLOT, B]) })
    act(() => { virtualClockPlay() })
    advance(2.05)
    expect(getVirtualClockSec()).toBeCloseTo(2.05, 3) // the file's own gap before c2, which sounds on B
    setQueueTargetSlots([])
  })

  // Review finding (Oct 29): the jump came from an effect after each beat, so
  // every beat that crossed into a skipped stretch first published a position
  // inside it, and a beat that came late — a background tab runs timers once
  // a second — played the silence through instead of skipping it.
  it("never publishes a position inside a stretch it skips", () => {
    const seen: (number | null)[] = []
    renderHook(() => { seen.push(useVirtualClockSec()) })
    renderHook(() => useSkipSilentLinesOnVirtualClock(cells, SLOTS, true))
    act(() => { virtualClockPlay() })
    advance(1)
    seen.length = 0
    advance(1.05)
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.filter((s) => s != null && s > 2 && s < 7)).toEqual([])
  })

  it("a late beat lands where a clock that skipped the silence would be", () => {
    // c1 [0,2] recorded; c2 [2,2.4] not; c3 [2.4,6] recorded. One beat a second.
    const short = [cue("c1", 0, 2, 2_000), cue("c2", 2, 2.4), cue("c3", 2.4, 6, 3_600)]
    renderHook(() => useSkipSilentLinesOnVirtualClock(short, SLOTS, true))
    act(() => { virtualClockPlay() })
    advance(1.9)
    advance(1)
    // 0.1 s more of c1, the 0.4 s of c2 skipped, then 0.9 s into c3.
    expect(getVirtualClockSec()).toBeCloseTo(3.3, 3)
  })

  it("does nothing while the built-in clock is not this file's transport", () => {
    renderHook(() => useSkipSilentLinesOnVirtualClock(cells, SLOTS, false))
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

    describe("with takes on added tracks (AQU-2252)", () => {
      const TRACK = "trk-1"
      /** `c` with a take on Track 1 too, starting on its line. */
      const onTrack = (c: CellData, ms: number): CellData => {
        const id = `audio-${c.id}-1700000500-track.webm`
        return {
          ...c,
          selectedBySlot: { [TRACK]: id },
          attachments: {
            ...c.attachments,
            [id]: { type: "audio", url: `http://audio.test/${c.id}-track.webm`, slot: TRACK, durationMs: ms, targetOffsetMs: 0 },
          },
        } as CellData
      }
      /** Laid out as the queue plays it, with Track 1 — a layer, or not. */
      const played = (cells: CellData[], layer: boolean) =>
        skipSilentLinesCanChange({
          timing: "audioFirst",
          runs: [cells],
          clockCells: null,
          slots: [RECORDING_SLOT, TRACK],
          tracks: { layerSlots: [TRACK], layerTrackSlots: layer ? [TRACK] : [] },
        })

      it("no: a line recorded only on an added track has something to play", () => {
        expect(played([cue("c1", 0, 2, 2_000), onTrack(cue("c2", 2, 4), 1_500)], false)).toBe(false)
      })

      it("no: a line that a music layer from the line before runs on over is held under it", () => {
        // c1's take on Track 1, a layer, runs 5 s from c1's start: over all of c2.
        expect(played([onTrack(cue("c1", 0, 2, 1_000), 5_000), cue("c2", 2, 4)], true)).toBe(false)
      })

      it("yes: once that layer is over, a line with nothing of its own is silent", () => {
        expect(played([onTrack(cue("c1", 0, 2, 1_000), 500), cue("c2", 2, 4)], true)).toBe(true)
      })
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
