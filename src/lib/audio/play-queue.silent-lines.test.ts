// AQU-2251 (Sam, Oct 28): "Skip lines with nothing to play".
//
// Following the recordings, a line with nothing to hear — no take and no
// original, like a book's stand-in for a verse nobody has recorded yet — is
// stepped over while the setting is on (the default, and what playback always
// did). Turned off, the line is played THROUGH in silence for as long as the
// timeline makes it: the playhead runs across it, it is the line playing, and
// then the next line plays. Next/previous line and seeks treat it as a line.
//
// The silence is held by the same clock that waits out a pause someone left
// before a take (AQU-2204), so these tests drive fake timers: the held clock is
// a ticker, not an element.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  getQueueProgress,
  getQueueState,
  linesPlaybackStopsAt,
  queuePlaybackAsk,
  linesHaveAnythingOfTheirOwnToPlay,
  onQueueRanOut,
  pauseQueue,
  resumeQueue,
  seekQueueToTime,
  setProgrammeFilm,
  setQueueTimingMode,
  skipBack,
  skipForward,
  startQueue,
  stopQueue,
  type PlayContext,
} from "./play-queue"
import { resetSkipSilentLinesPrefCacheForTests, setSkipSilentLinesPref } from "@/lib/store/skip-silent-lines-pref"
import type { CellData } from "@/hooks/useCells"

class FakeAudio {
  static instances: FakeAudio[] = []
  private _t = 0
  get currentTime(): number {
    return this._t
  }
  set currentTime(v: number) {
    this._t = v
  }
  duration = 600
  paused = true
  ended = false
  muted = false
  volume = 1
  playbackRate = 1
  readyState = 4
  preload = ""
  error = null
  src: string
  onended: (() => void) | null = null
  onerror: (() => void) | null = null
  ontimeupdate: (() => void) | null = null
  onloadedmetadata: (() => void) | null = null
  oncanplay: (() => void) | null = null
  onplay: (() => void) | null = null
  onpause: (() => void) | null = null
  constructor(src: string) {
    this.src = src
    FakeAudio.instances.push(this)
    queueMicrotask(() => this.onloadedmetadata?.())
  }
  async play(): Promise<void> {
    this.paused = false
    this.onplay?.()
  }
  pause(): void {
    if (this.paused) return
    this.paused = true
    this.onpause?.()
  }
  /** A timeupdate tick — playback progress, not a seek. */
  tick(t: number): void {
    this._t = t
    this.ontimeupdate?.()
  }
  private listeners = new Map<string, Set<() => void>>()
  addEventListener(type: string, fn: () => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type)!.add(fn)
    if (type === "canplay" || type === "seeked") queueMicrotask(() => fn())
  }
  removeEventListener(type: string, fn: () => void): void {
    this.listeners.get(type)?.delete(fn)
  }
}

/**
 * A line of a book with no times. Recorded: a take of `takeMs`. Not recorded:
 * a stand-in from its words — "bN words" is 8 characters, which reads in well
 * under the 1.5 s floor, so every stand-in here lasts exactly 1.5 s.
 */
function bookLine(id: string, takeMs?: number): CellData {
  const takeId = `audio-${id}-1700000000-take.webm`
  return {
    id,
    fileId: "f1",
    original: `${id} words`,
    translated: "",
    medium: "text",
    ...(takeMs != null ? { selectedAudioId: takeId } : {}),
    attachments:
      takeMs != null ? { [takeId]: { type: "audio", url: `http://audio.test/${id}.webm`, durationMs: takeMs } } : {},
  } as unknown as CellData
}

const ctxFor = (cells: CellData[]): PlayContext => ({
  cells,
  projectId: "p1",
  session: { jwt: "t", username: "dev", createdAt: "" } as PlayContext["session"],
})

const dubEl = (id: string): FakeAudio | undefined =>
  [...FakeAudio.instances].reverse().find((a) => a.src.includes(`/${id}.webm`))
const anythingSounding = (): boolean => FakeAudio.instances.some((a) => !a.paused)

/** Let the transport's awaits settle, then move the clock on `ms`. */
const wait = (ms = 0) => vi.advanceTimersByTimeAsync(ms)

// b1 recorded 2 s → [0, 2); b2 a stand-in → [2, 3.5); b3 recorded 3 s → [3.5, 6.5).
const book = () => [bookLine("b1", 2_000), bookLine("b2"), bookLine("b3", 3_000)]

beforeEach(() => {
  FakeAudio.instances = []
  vi.stubGlobal("Audio", FakeAudio)
  localStorage.removeItem("aq.skip-silent-lines.v1")
  resetSkipSilentLinesPrefCacheForTests()
  vi.useFakeTimers()
  setQueueTimingMode("audioFirst")
})

afterEach(() => {
  stopQueue()
  setQueueTimingMode("dubbing")
  vi.useRealTimers()
  vi.unstubAllGlobals()
  localStorage.removeItem("aq.skip-silent-lines.v1")
  resetSkipSilentLinesPrefCacheForTests()
})

describe("following the recordings, with Skip lines with nothing to play ON (the default)", () => {
  it("Play all goes from one recorded line straight to the next", async () => {
    startQueue(ctxFor(book()), 0)
    await wait()
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b1" })

    dubEl("b1")!.tick(2)
    await wait()
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b3" })
    expect(getQueueProgress().currentTime).toBe(3.5)
  })

  it("a seek onto a line with nothing to hear moves on to the next recorded line", async () => {
    startQueue(ctxFor(book()), 0)
    await wait()
    seekQueueToTime(2.5)
    await wait()
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b3" })
  })

  it("next line steps over a line with nothing to hear", async () => {
    startQueue(ctxFor(book()), 0)
    await wait()
    skipForward()
    await wait()
    expect(getQueueState()).toMatchObject({ cellId: "b3" })
  })
})

describe("following the recordings, with Skip lines with nothing to play OFF", () => {
  beforeEach(() => {
    setSkipSilentLinesPref(false)
  })

  it("plays a line with nothing to hear through in silence for its length, then the next line", async () => {
    startQueue(ctxFor(book()), 0)
    await wait()
    dubEl("b1")!.tick(2)
    await wait()

    // On the stand-in: it is the line playing, nothing sounds, the clock is at its start.
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b2" })
    expect(getQueueProgress().currentTime).toBe(2)
    expect(anythingSounding()).toBe(false)

    // The playhead runs across it.
    await wait(500)
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b2" })
    expect(getQueueProgress().currentTime).toBeCloseTo(2.5, 1)
    await wait(600)
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b2" })
    expect(getQueueProgress().currentTime).toBeCloseTo(3.1, 1)
    expect(anythingSounding()).toBe(false)

    // Its 1.5 s are up: the next line plays from its start.
    await wait(450)
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b3" })
    expect(getQueueProgress().currentTime).toBe(3.5)
    expect(dubEl("b3")!.paused).toBe(false)
  })

  it("Play all from the top starts on a first line with nothing to hear", async () => {
    startQueue(ctxFor([bookLine("b0"), bookLine("b1", 2_000)]), 0)
    await wait()
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b0" })
    expect(getQueueProgress().currentTime).toBe(0)

    await wait(1_550)
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b1" })
    expect(getQueueProgress().currentTime).toBe(1.5)
  })

  it("next and previous line land on a line with nothing to hear", async () => {
    startQueue(ctxFor(book()), 0)
    await wait()
    skipForward()
    await wait()
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b2" })
    expect(getQueueProgress().currentTime).toBe(2)

    skipForward()
    await wait()
    expect(getQueueState()).toMatchObject({ cellId: "b3" })

    skipBack()
    await wait()
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b2" })
  })

  it("a seek onto a line with nothing to hear stays there and plays it through", async () => {
    startQueue(ctxFor(book()), 0)
    await wait()
    seekQueueToTime(2.5)
    await wait()
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b2" })
    expect(getQueueProgress().currentTime).toBe(2.5)

    await wait(1_050)
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b3" })
  })

  it("pausing on it holds the place, and resuming carries on through the rest of it", async () => {
    startQueue(ctxFor(book()), 0)
    await wait()
    dubEl("b1")!.tick(2)
    await wait()
    await wait(500)

    pauseQueue()
    expect(getQueueState()).toMatchObject({ kind: "paused", cellId: "b2" })
    const at = getQueueProgress().currentTime
    expect(at).toBeCloseTo(2.5, 1)

    await wait(5_000)
    expect(getQueueState()).toMatchObject({ kind: "paused", cellId: "b2" })
    expect(getQueueProgress().currentTime).toBe(at)

    await resumeQueue()
    await wait()
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b2" })
    await wait(500)
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b2" })
    await wait(600)
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b3" })
  })

  it("a last line with nothing to hear plays out before the run ends", async () => {
    const ranOut = vi.fn()
    const off = onQueueRanOut(ranOut)
    try {
      startQueue(ctxFor([bookLine("b1", 2_000), bookLine("b2")]), 0)
      await wait()
      dubEl("b1")!.tick(2)
      await wait()
      expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b2" })
      expect(ranOut).not.toHaveBeenCalled()

      await wait(1_550)
      expect(getQueueState().kind).toBe("idle")
      expect(ranOut).toHaveBeenCalledTimes(1)
    } finally {
      off()
    }
  })

  it("the take after a line with nothing to hear is made ready while that line plays", async () => {
    startQueue(ctxFor(book()), 0)
    await wait()
    dubEl("b1")!.tick(2)
    await wait()
    expect(getQueueState()).toMatchObject({ cellId: "b2" })
    // b3's take is already loading, so its line starts on time when b2 ends.
    expect(dubEl("b3")).toBeDefined()
    expect(dubEl("b3")!.paused).toBe(true)
  })
})

// AQU-2251 (Sam, Oct 29): following the recordings, a hidden line is skipped —
// the playhead jumps it. Turning "Skip lines with nothing to play" off plays an
// unrecorded line through in silence, but never a hidden one. A hidden line
// keeps its place on the timeline; playback steps over it either way, whether
// it never had a take or its take is one that never sounds. (Following the
// source under a film or a recording, it is passed through instead:
// play-queue.hidden-lines.test.ts.)
describe.each([
  ["ON", true],
  ["OFF", false],
])("following the recordings, a hidden line is skipped with the setting %s", (_label, on) => {
  const hidden = (cell: CellData): CellData => ({ ...cell, hidden: true }) as CellData
  // b1 recorded 2 s → [0, 2); b2 hidden, a stand-in → [2, 3.5); b3 recorded 3 s → [3.5, 6.5).
  const withHiddenStandIn = () => [bookLine("b1", 2_000), hidden(bookLine("b2")), bookLine("b3", 3_000)]
  // b2 hidden with a 1 s take that never sounds → [2, 3); b3 → [3, 6).
  const withHiddenTake = () => [bookLine("b1", 2_000), hidden(bookLine("b2", 1_000)), bookLine("b3", 3_000)]

  beforeEach(() => {
    setSkipSilentLinesPref(on)
  })

  it("Play all goes from the line before it straight to the line after it", async () => {
    startQueue(ctxFor(withHiddenStandIn()), 0)
    await wait()
    dubEl("b1")!.tick(2)
    await wait()
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b3" })
    expect(getQueueProgress().currentTime).toBe(3.5)
  })

  it("a hidden line whose take never sounds is stepped over too", async () => {
    startQueue(ctxFor(withHiddenTake()), 0)
    await wait()
    dubEl("b1")!.tick(2)
    await wait()
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b3" })
    expect(getQueueProgress().currentTime).toBe(3)
    expect(dubEl("b2")?.paused ?? true).toBe(true)
  })

  it("Play all from the top starts after a first line that is hidden", async () => {
    startQueue(ctxFor([hidden(bookLine("b0")), bookLine("b1", 2_000)]), 0)
    await wait()
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b1" })
    expect(getQueueProgress().currentTime).toBe(1.5)
  })

  it("next and previous line step over it", async () => {
    startQueue(ctxFor(withHiddenStandIn()), 0)
    await wait()
    skipForward()
    await wait()
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b3" })
    skipBack()
    await wait()
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b1" })
  })

  it("a seek onto it moves on to the next line", async () => {
    startQueue(ctxFor(withHiddenStandIn()), 0)
    await wait()
    seekQueueToTime(2.5)
    await wait()
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b3" })
  })

  it("a last line that is hidden ends the run when the line before it ends", async () => {
    const ranOut = vi.fn()
    const off = onQueueRanOut(ranOut)
    try {
      startQueue(ctxFor([bookLine("b1", 2_000), hidden(bookLine("b2"))]), 0)
      await wait()
      dubEl("b1")!.tick(2)
      await wait()
      expect(getQueueState().kind).toBe("idle")
      expect(ranOut).toHaveBeenCalledTimes(1)
    } finally {
      off()
    }
  })
})

// AQU-2253 (Sam, Nov 9): "the rule 'skip lines with nothing to play' should
// only land when there is literally nothing to play: recorded or source." A
// line whose only sound is its original (a section of an imported recording
// nobody has recorded over) has its source to play: it is never skipped, and
// it is something to play for the Play button and for Play all's run into the
// next chapter, whether or not the original is the line's selected audio.
describe("a line with only its original is never skipped (Sam, Nov 9)", () => {
  const SOURCE_ID = "audio-f1-1690000000-shared.mp3"
  /** A section of an imported recording, nothing recorded over it. */
  const section = (id: string, start: number, end: number, selected: boolean): CellData =>
    ({
      id,
      fileId: "f1",
      original: `${id} words`,
      translated: "",
      medium: "media",
      startTime: start,
      endTime: end,
      ...(selected ? { selectedAudioId: SOURCE_ID } : {}),
      attachments: { [SOURCE_ID]: { type: "audio", url: "http://audio.test/clip.mp3" } },
    }) as unknown as CellData

  /** A timed line of the same file with a take of `takeMs`, and no original. */
  const timed = (id: string, start: number, end: number, takeMs?: number): CellData =>
    ({ ...bookLine(id, takeMs), medium: "media", startTime: start, endTime: end }) as CellData

  for (const selected of [true, false]) {
    const which = selected ? "the line's selected audio" : "not the line's selected audio"

    it(`with Skip on, Play all plays it (the original ${which})`, async () => {
      // b1 recorded 2 s [0, 2); s2 only its original, 3 s [2, 5); b3 recorded 3 s [5, 8).
      startQueue(ctxFor([timed("b1", 0, 2, 2_000), section("s2", 10, 13, selected), timed("b3", 20, 23, 3_000)]), 0)
      await wait()
      dubEl("b1")!.tick(2)
      await wait()
      expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "s2" })
      expect(getQueueProgress().currentTime).toBeCloseTo(2, 2)
      expect(FakeAudio.instances.some((a) => a.src.includes("clip.mp3") && !a.paused)).toBe(true)
    })

    it(`next line goes to it, and the Play button has something to play (the original ${which})`, async () => {
      const cells = [timed("b1", 0, 2, 2_000), section("s2", 10, 13, selected), timed("b3", 20, 23, 3_000)]
      startQueue(ctxFor(cells), 0)
      await wait()
      skipForward()
      await wait()
      expect(getQueueState()).toMatchObject({ cellId: "s2" })
      // Only originals, nothing recorded: still something to play.
      expect(linesPlaybackStopsAt([section("s1", 0, 3, selected), section("s2", 3, 6, selected)], queuePlaybackAsk()).size).toBe(2)
      expect(linesPlaybackStopsAt([section("s1", 0, 3, selected)], { ...queuePlaybackAsk(), film: null }).size > 0).toBe(true)
      // …and something of its own, for Play all's move into its chapter.
      expect(linesHaveAnythingOfTheirOwnToPlay([section("s1", 0, 3, selected)])).toBe(true)
    })
  }

  it("a line with no recording and no original is still nothing to play", () => {
    expect(linesPlaybackStopsAt([bookLine("b1"), bookLine("b2")], queuePlaybackAsk()).size).toBe(0)
    expect(linesPlaybackStopsAt([bookLine("b1"), bookLine("b2")], { ...queuePlaybackAsk(), film: null }).size > 0).toBe(false)
    expect(linesHaveAnythingOfTheirOwnToPlay([bookLine("b1"), bookLine("b2")])).toBe(false)
  })
})

// AQU-2432 (Sam, Nov 9): an unrecorded line's ROOM. Dragging the next take
// earlier against a line nobody has recorded makes that line's room smaller,
// down to nothing (lib/timeline/line-room). Playback follows the room: the
// line lasts its room, and a line with no room has no time to play at all.
describe("an unrecorded line's room, following the recordings (AQU-2432)", () => {
  // b1 recorded 2 s → [0, 2); b2 unrecorded, given `roomMs` of its 1.5 s; b3 recorded 3 s.
  const withRoom = (roomMs: number) => [
    bookLine("b1", 2_000),
    { ...bookLine("b2"), recordingsRoomMs: roomMs } as CellData,
    bookLine("b3", 3_000),
  ]

  describe("with Skip lines with nothing to play ON", () => {
    it("a line with a smaller room is stepped over as always, and the next take starts where its room ends", async () => {
      startQueue(ctxFor(withRoom(500)), 0)
      await wait()
      expect(getQueueProgress().duration).toBe(5.5)
      dubEl("b1")!.tick(2)
      await wait()
      expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b3" })
      expect(getQueueProgress().currentTime).toBe(2.5)
    })

    it("a line with no room: the next take follows the one before it at once", async () => {
      startQueue(ctxFor(withRoom(0)), 0)
      await wait()
      expect(getQueueProgress().duration).toBe(5)
      dubEl("b1")!.tick(2)
      await wait()
      expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b3" })
      expect(getQueueProgress().currentTime).toBe(2)
      expect(dubEl("b3")!.paused).toBe(false)
    })
  })

  describe("with Skip lines with nothing to play OFF", () => {
    beforeEach(() => {
      setSkipSilentLinesPref(false)
    })

    it("the line plays through in silence for its ROOM, not its natural length", async () => {
      startQueue(ctxFor(withRoom(500)), 0)
      await wait()
      dubEl("b1")!.tick(2)
      await wait()
      expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b2" })
      expect(getQueueProgress().currentTime).toBe(2)
      await wait(300)
      expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b2" })
      await wait(250)
      expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b3" })
      expect(getQueueProgress().currentTime).toBe(2.5)
    })

    it("a line with no room has no time to play: it is never the line playing, and the next take follows at once", async () => {
      const playing: string[] = []
      startQueue(ctxFor(withRoom(0)), 0)
      await wait()
      dubEl("b1")!.tick(2)
      // Every state on the way, not only where it settles.
      for (let i = 0; i < 6; i++) {
        await Promise.resolve()
        const s = getQueueState()
        if (s.kind === "playing") playing.push(s.cellId)
      }
      await wait()
      const s = getQueueState()
      if (s.kind === "playing") playing.push(s.cellId)
      expect(playing).not.toContain("b2")
      expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b3" })
      expect(getQueueProgress().currentTime).toBe(2)
      expect(dubEl("b3")!.paused).toBe(false)
    })

    it("next and previous line step over a line with no room", async () => {
      startQueue(ctxFor(withRoom(0)), 0)
      await wait()
      skipForward()
      await wait()
      expect(getQueueState()).toMatchObject({ cellId: "b3" })
      skipBack()
      await wait()
      expect(getQueueState()).toMatchObject({ cellId: "b1" })
    })

    it("Play all from the top passes a first line with no room", async () => {
      startQueue(ctxFor([{ ...bookLine("b0"), recordingsRoomMs: 0 } as CellData, bookLine("b1", 2_000)]), 0)
      await wait()
      expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b1" })
      expect(getQueueProgress().currentTime).toBe(0)
    })
  })
})

// The merge of dev into the film bundle (Nov 19): dev's AQU-2432 rule, "a line
// squeezed to no room is never a stop", holds with the bundle's own rules for
// what playback stops at: "Play selected" (`PlayContext.only`) and a linked
// film behind the lines (a line the film plays behind is played whatever Skip
// says). A line with no room has no time of its own, film or no film.
describe("a line with no room, in Play selected and under a linked film (the merge, Nov 19)", () => {
  const withRoom = (roomMs: number) => [
    bookLine("b1", 2_000),
    { ...bookLine("b2"), recordingsRoomMs: roomMs } as CellData,
    bookLine("b3", 3_000),
  ]
  const filmOver = (cells: CellData[]) => ({ endSec: 60, cellIds: new Set(cells.map((c) => c.id)) })

  afterEach(() => {
    setProgrammeFilm(null)
  })

  it("Play selected with the line chosen: next line steps over it, Skip off", async () => {
    setSkipSilentLinesPref(false)
    const cells = withRoom(0)
    startQueue({ ...ctxFor(cells), only: new Set(["b1", "b2", "b3"]) }, 0)
    await wait()
    expect(getQueueState()).toMatchObject({ cellId: "b1" })
    skipForward()
    await wait()
    expect(getQueueState()).toMatchObject({ cellId: "b3" })
    skipBack()
    await wait()
    expect(getQueueState()).toMatchObject({ cellId: "b1" })
  })

  it("Play selected still stops only at the chosen lines", async () => {
    setSkipSilentLinesPref(false)
    const cells = withRoom(500)
    startQueue({ ...ctxFor(cells), only: new Set(["b1", "b3"]) }, 0)
    await wait()
    skipForward()
    await wait()
    expect(getQueueState()).toMatchObject({ cellId: "b3" })
  })

  it("under a linked film, next line steps over it, Skip on", async () => {
    const cells = withRoom(0)
    setProgrammeFilm(filmOver(cells))
    startQueue(ctxFor(cells), 0)
    await wait()
    skipForward()
    await wait()
    expect(getQueueState()).toMatchObject({ cellId: "b3" })
  })

  it("under a linked film, a line WITH room is still a stop, Skip on", async () => {
    const cells = withRoom(500)
    setProgrammeFilm(filmOver(cells))
    startQueue(ctxFor(cells), 0)
    await wait()
    skipForward()
    await wait()
    expect(getQueueState()).toMatchObject({ cellId: "b2" })
  })

  it("the stops the Play buttons count leave it out, film or Skip off", () => {
    const cells = withRoom(0)
    const film = filmOver(cells)
    expect([...linesPlaybackStopsAt(cells, { ...queuePlaybackAsk(), film, skipSilent: true })]).toEqual(["b1", "b3"])
    expect([...linesPlaybackStopsAt(cells, { ...queuePlaybackAsk(), film: null, skipSilent: false })]).toEqual(["b1", "b3"])
    // With room it is counted, as before.
    expect(linesPlaybackStopsAt(withRoom(500), { ...queuePlaybackAsk(), film, skipSilent: true }).has("b2")).toBe(true)
  })
})
