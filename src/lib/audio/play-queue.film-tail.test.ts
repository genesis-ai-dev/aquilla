// AQU-2253 (Sam, Nov 9): following the recordings, a LINKED film plays on its
// own clock, so Play runs to whichever ends later: the lines or the film.
//
// The film is not the queue's to play: its picture follows the programme's
// clock (MediaVideoPane), with its own sound. What the queue does is keep that
// clock running past the last line, to the film's end, the way it already does
// under a take on another track that runs on past the last line
// (`progEnterTail`). The workspace says how long the film is and which lines
// it belongs to (`setProgrammeFilm`); with no film, an imported one, one that
// could not be loaded, or following the source, it says nothing and playback
// ends where the lines end, as it always did.
//
// AQU-2253 (review, Nov 9): where only the film plays (its tail, and the whole
// run when nothing is recorded) the FILM is the clock, as it is following the
// source: the film panel reports the film's second (`tickProgrammeFilm`) and
// the queue's clock takes it. So these tests run a stand-in for the panel's
// film (`film`, below) on fake timers: it follows the queue as the panel does
// and reports four times a second. `film.stuck` is a film that is buffering.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook } from "@testing-library/react"
import {
  getQueueProgress,
  getQueueState,
  hasAnyPlayableAudio,
  hasPlayableAudio,
  linesHaveAnythingOfTheirOwnToPlay,
  linesHaveAnythingToPlayCountingFilm,
  onQueueRanOut,
  pauseQueue,
  resumeQueue,
  seekQueueToTime,
  setProgrammeFilm,
  setQueueAudibility,
  setQueueLayerTrackSlots,
  setQueueRate,
  setQueueTargetSlots,
  setQueueTimingMode,
  setQueueVolume,
  skipBack,
  skipForward,
  startQueue,
  startQueueAtTime,
  stopQueue,
  tickProgrammeFilm,
  updateQueueCells,
  useIsQueueCurrentCell,
  useQueueCellPlayhead,
  useQueueCurrentCellId,
  type PlayContext,
} from "./play-queue"
import { resetSkipSilentLinesPrefCacheForTests, setSkipSilentLinesPref } from "@/lib/store/skip-silent-lines-pref"
import { nextChapterForPlayAll } from "@/lib/timeline/chapter-pick"
import { videoSyncAction } from "@/components/timeline/video-sync"
import { chapterOfCell, scopeCells, type TimelineChapter } from "@/lib/timeline/sequence-timeline"
import type { CellData } from "@/hooks/useCells"

class FakeAudio {
  static instances: FakeAudio[] = []
  /** AQU-2253 (review 2): takes whose bytes never arrive (never ready)… */
  static cold = new Set<string>()
  /** …and takes that fail to load. */
  static failing = new Set<string>()
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
  error: { code: number } | null = null
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
    if (FakeAudio.cold.has(src)) this.readyState = 0
    if (FakeAudio.failing.has(src)) {
      this.error = { code: 4 }
      queueMicrotask(() => this.onerror?.())
      return
    }
    queueMicrotask(() => this.onloadedmetadata?.())
  }
  /** The take dies where it is (an expired stream, a decode fault). */
  fail(): void {
    this.error = { code: 2 }
    this.paused = true
    this.onerror?.()
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

const TRACK = "trk-1"

/**
 * A line of a file with a linked film. Recorded: a take of `takeMs` on the
 * main track. Not recorded: a stand-in from its words, which here always
 * lasts exactly 1.5 s ("bN words" reads in well under the 1.5 s floor).
 * `layerMs`: a take on Track 1 as well, from the line's start.
 */
function line(id: string, takeMs?: number, layerMs?: number): CellData {
  const takeId = `audio-${id}-1700000000-take.webm`
  const layerId = `audio-${id}-1700000500-track.webm`
  return {
    id,
    fileId: "f1",
    original: `${id} words`,
    translated: "",
    medium: "text",
    ...(takeMs != null ? { selectedAudioId: takeId } : {}),
    ...(layerMs != null ? { selectedBySlot: { [TRACK]: layerId } } : {}),
    attachments: {
      ...(takeMs != null ? { [takeId]: { type: "audio", url: `http://audio.test/${id}.webm`, slot: "recording", durationMs: takeMs } } : {}),
      ...(layerMs != null
        ? { [layerId]: { type: "audio", url: `http://audio.test/${id}-track.webm`, slot: TRACK, durationMs: layerMs, targetOffsetMs: 0 } }
        : {}),
    },
  } as unknown as CellData
}

const ctxFor = (cells: CellData[], over: Partial<PlayContext> = {}): PlayContext => ({
  cells,
  projectId: "p1",
  session: { jwt: "t", username: "dev", createdAt: "" } as PlayContext["session"],
  ...over,
})

/** The workspace's word: this file's lines have a linked film `endSec` long. */
const linkFilm = (endSec: number, cells: CellData[]) =>
  setProgrammeFilm({ endSec, cellIds: new Set(cells.map((c) => c.id)) })

const el = (name: string): FakeAudio | undefined =>
  [...FakeAudio.instances].reverse().find((a) => a.src === `http://audio.test/${name}.webm`)
const anythingSounding = (): boolean => FakeAudio.instances.some((a) => !a.paused)

/** Let the transport's awaits settle, then move the clock on `ms`. */
const wait = (ms = 0) => vi.advanceTimersByTimeAsync(ms)

// b1 recorded 2 s → [0, 2); b2 recorded 3 s → [2, 5). The lines end at 5 s.
const recorded = () => [line("b1", 2_000), line("b2", 3_000)]

/** Play the two recorded lines out, to the end of the last one. */
async function playTheLinesOut(cells: CellData[], over: Partial<PlayContext> = {}): Promise<void> {
  startQueue(ctxFor(cells, over), 0)
  await wait()
  el("b1")!.tick(2)
  await wait()
  expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b2" })
  el("b2")!.tick(3)
  await wait()
}

let ranOut = 0
let stopRanOut: () => void = () => {}

/**
 * The film in its panel, as MediaVideoPane runs it: while the queue runs it
 * plays; under a line it is kept at the queue's clock; where the film is the
 * clock it is only sent to the queue's second when that is far from its own
 * (a seek), and it reports its own second four times a second, unless it is
 * `stuck` (buffering, or not started). AQU-2253 (review 2, Nov 9): while the
 * queue listens for a film it gave up waiting on (`filmQuiet`), it reports as
 * it follows the queue too, so it is heard from again once it plays.
 */
const film = { sec: 0, stuck: false, reports: 0 }
let filmTimer: ReturnType<typeof setInterval> | null = null
function filmBeat(): void {
  const kind = getQueueState().kind
  const p = getQueueProgress()
  if ((kind !== "playing" && kind !== "loading") || !p.programmeClock) return
  if (!p.filmClock) {
    film.sec = p.currentTime
    if (!film.stuck && p.filmQuiet) tickProgrammeFilm(film.sec)
    return
  }
  if (Math.abs(film.sec - p.currentTime) > 0.85) film.sec = p.currentTime
  if (film.stuck) return
  film.sec += 0.25 * p.rate
  film.reports++
  tickProgrammeFilm(film.sec)
}

beforeEach(() => {
  FakeAudio.instances = []
  FakeAudio.cold.clear()
  FakeAudio.failing.clear()
  vi.stubGlobal("Audio", FakeAudio)
  localStorage.removeItem("aq.skip-silent-lines.v1")
  resetSkipSilentLinesPrefCacheForTests()
  vi.useFakeTimers()
  setQueueTargetSlots(["recording"])
  setQueueLayerTrackSlots([])
  setQueueTimingMode("audioFirst")
  ranOut = 0
  stopRanOut = onQueueRanOut(() => { ranOut++ })
  film.sec = 0
  film.stuck = false
  film.reports = 0
  filmTimer = setInterval(filmBeat, 250)
})

afterEach(() => {
  if (filmTimer != null) clearInterval(filmTimer)
  filmTimer = null
  stopRanOut()
  stopQueue()
  setProgrammeFilm(null)
  setQueueRate(1)
  setQueueTimingMode("dubbing")
  setQueueTargetSlots(["recording"])
  setQueueLayerTrackSlots([])
  vi.useRealTimers()
  vi.unstubAllGlobals()
  localStorage.removeItem("aq.skip-silent-lines.v1")
  resetSkipSilentLinesPrefCacheForTests()
})

describe("a linked film longer than the lines: Play runs on to the film's end", () => {
  it("carries on past the last line, the clock moving and the transport playing, and stops at the film's end", async () => {
    const cells = recorded()
    linkFilm(12, cells)
    await playTheLinesOut(cells)

    // The last line is over. Still playing, on the film's clock, from 5 s.
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b2" })
    expect(getQueueProgress().currentTime).toBeCloseTo(5, 2)
    expect(getQueueProgress().programmeClock).toBe(true)
    // None of the queue's own players sound there: the film voices itself.
    expect(anythingSounding()).toBe(false)
    expect(ranOut).toBe(0)

    await wait(3_000)
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b2" })
    expect(getQueueProgress().currentTime).toBeCloseTo(8, 1)

    // 12 s: the film's end.
    await wait(4_050)
    expect(getQueueState().kind).toBe("idle")
    expect(ranOut).toBe(1)
  })

  it("the length the transport reports is the film's", async () => {
    const cells = recorded()
    linkFilm(12, cells)
    startQueue(ctxFor(cells), 0)
    await wait()
    expect(getQueueProgress().duration).toBeCloseTo(12, 5)
  })

  it("a click past the last line, then Play, plays the film from there to its end", async () => {
    const cells = recorded()
    linkFilm(12, cells)
    // The click: the queue is idle, so it is cued, paused, where the click was.
    startQueueAtTime(ctxFor(cells), 9, { play: false })
    await wait()
    expect(getQueueState()).toMatchObject({ kind: "paused", cellId: "b2" })
    expect(getQueueProgress().currentTime).toBeCloseTo(9, 5)

    await resumeQueue()
    await wait()
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b2" })
    expect(getQueueProgress().currentTime).toBeCloseTo(9, 1)
    // Not the lines again.
    expect(anythingSounding()).toBe(false)

    await wait(1_000)
    expect(getQueueProgress().currentTime).toBeCloseTo(10, 1)
    await wait(2_050)
    expect(getQueueState().kind).toBe("idle")
    expect(ranOut).toBe(1)
  })

  it("a seek past the last line while playing keeps playing from there", async () => {
    const cells = recorded()
    linkFilm(12, cells)
    startQueue(ctxFor(cells), 0)
    await wait()
    seekQueueToTime(10)
    await wait()
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b2" })
    expect(getQueueProgress().currentTime).toBeCloseTo(10, 1)
    expect(anythingSounding()).toBe(false)
    await wait(2_050)
    expect(getQueueState().kind).toBe("idle")
  })
})

describe("no line is playing over the film's tail (what captions the picture reads)", () => {
  it("says so past the last line, playing or cued there, and not on a line", async () => {
    const cells = recorded()
    linkFilm(12, cells)
    startQueue(ctxFor(cells), 0)
    await wait()
    expect(getQueueProgress().filmTail).toBe(false)
    el("b1")!.tick(2)
    await wait()
    expect(getQueueProgress().filmTail).toBe(false)
    el("b2")!.tick(3)
    await wait()
    expect(getQueueProgress().filmTail).toBe(true)
    await wait(1_000)
    expect(getQueueProgress().filmTail).toBe(true)
    pauseQueue()
    expect(getQueueProgress().filmTail).toBe(true)
    // Back onto a line: that line is playing again.
    seekQueueToTime(3, { play: true })
    await wait()
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b2" })
    expect(getQueueProgress().filmTail).toBe(false)
  })

  it("a film shorter than the lines has no tail: the last line is the line, to its last moment", async () => {
    const cells = recorded()
    linkFilm(3, cells)
    startQueueAtTime(ctxFor(cells), 9, { play: false })
    await wait()
    expect(getQueueState()).toMatchObject({ kind: "paused", cellId: "b2" })
    expect(getQueueProgress().filmTail).toBe(false)
  })

  it("under a take on another track playing out with no film, the last line is still the line playing", async () => {
    setQueueTargetSlots(["recording", TRACK])
    setQueueLayerTrackSlots([TRACK])
    await playTheLinesOut([line("b1", 2_000), line("b2", 3_000, 5_000)])
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b2" })
    expect(getQueueProgress().filmTail).toBe(false)
  })
})

describe("over the film's tail, the transport's other commands", () => {
  it("pause holds the clock where it is, and Play carries on from there", async () => {
    const cells = recorded()
    linkFilm(12, cells)
    await playTheLinesOut(cells)
    await wait(2_000)
    pauseQueue()
    expect(getQueueState()).toMatchObject({ kind: "paused", cellId: "b2" })
    const at = getQueueProgress().currentTime
    expect(at).toBeCloseTo(7, 1)

    // Paused is paused: nothing moves, nothing ends.
    await wait(20_000)
    expect(getQueueState()).toMatchObject({ kind: "paused" })
    expect(getQueueProgress().currentTime).toBe(at)

    await resumeQueue()
    await wait(1_000)
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b2" })
    expect(getQueueProgress().currentTime).toBeCloseTo(8, 1)
    await wait(4_050)
    expect(getQueueState().kind).toBe("idle")
  })

  it("a seek back into the lines plays the line there", async () => {
    const cells = recorded()
    linkFilm(12, cells)
    await playTheLinesOut(cells)
    await wait(1_000)
    seekQueueToTime(1)
    await wait()
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b1" })
    expect(getQueueProgress().currentTime).toBeCloseTo(1, 2)
    expect(el("b1")!.paused).toBe(false)
    // The tail's clock is gone: nothing ends the run while b1 plays.
    await wait(20_000)
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b1" })
  })

  it("previous line goes back to the last line", async () => {
    const cells = recorded()
    linkFilm(12, cells)
    await playTheLinesOut(cells)
    await wait(1_000)
    skipBack()
    await wait()
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b2" })
    expect(getQueueProgress().currentTime).toBeCloseTo(2, 2)
  })

  it("Stop stops, and nothing starts again later", async () => {
    const cells = recorded()
    linkFilm(12, cells)
    await playTheLinesOut(cells)
    await wait(1_000)
    stopQueue()
    expect(getQueueState().kind).toBe("idle")
    await wait(20_000)
    expect(getQueueState().kind).toBe("idle")
    expect(ranOut).toBe(0)
  })

  it("a change of speed moves the clock at the new speed from where it was", async () => {
    const cells = recorded()
    linkFilm(12, cells)
    await playTheLinesOut(cells)
    await wait(1_000)
    expect(getQueueProgress().currentTime).toBeCloseTo(6, 1)
    setQueueRate(2)
    // 6 s left of the film, at double speed: 2 s of it in 1 s...
    await wait(1_000)
    expect(getQueueState()).toMatchObject({ kind: "playing" })
    expect(getQueueProgress().currentTime).toBeCloseTo(8, 1)
    // ...and its end 3 s after the change, not 6.
    await wait(2_050)
    expect(getQueueState().kind).toBe("idle")
  })

  it("a take landing meanwhile does not disturb it", async () => {
    const cells = recorded()
    linkFilm(12, cells)
    await playTheLinesOut(cells)
    await wait(1_000)
    // The bar hands the queue the file's lines again on every change.
    updateQueueCells(recorded())
    await wait(1_000)
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b2" })
    expect(getQueueProgress().currentTime).toBeCloseTo(7, 1)
    expect(getQueueProgress().duration).toBeCloseTo(12, 5)
  })

  it("a line added meanwhile does not end it, whichever of the film's word and the run's list arrives first", async () => {
    const cells = recorded()
    linkFilm(12, cells)
    await playTheLinesOut(cells)
    await wait(1_000)
    // b0 is new, ahead of the others: the lines still end at b2.
    const more = [line("b0"), ...recorded()]
    // The film's word first: for a beat its lines are not the run's.
    linkFilm(12, more)
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b2" })
    updateQueueCells(more)
    linkFilm(12, more)
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b2" })
    // The lines are 1.5 s longer now (b0's stand-in); the film ends where it did.
    expect(getQueueProgress().duration).toBeCloseTo(12, 5)
    await wait(10_000)
    expect(getQueueState().kind).toBe("idle")
  })

  it("the film's length arriving late, over the tail of a take on another track, carries the run on to the film's end", async () => {
    setQueueTargetSlots(["recording", TRACK])
    setQueueLayerTrackSlots([TRACK])
    // b2's Track 1 take runs to 7 s, 2 s past the lines' end.
    const cells = [line("b1", 2_000), line("b2", 3_000, 5_000)]
    await playTheLinesOut(cells)
    await wait(1_000)
    linkFilm(12, cells)
    expect(getQueueProgress().duration).toBeCloseTo(12, 5)
    await wait(3_000)
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b2" })
    // The take's last second on the queue's clock, then the film's from 7 s
    // (the stand-in film here joins a beat behind, and is waited for).
    expect(Math.abs(getQueueProgress().currentTime - 9)).toBeLessThanOrEqual(0.3)
    await wait(3_050)
    expect(getQueueState().kind).toBe("idle")
  })
})

describe("where Play still ends with the lines", () => {
  it("no film to run on (none, an imported one, one that could not be loaded): ends at the last line's end", async () => {
    await playTheLinesOut(recorded())
    expect(getQueueState().kind).toBe("idle")
    expect(ranOut).toBe(1)
  })

  it("a film that stops being playable over its tail ends the run there: no waiting on a dead film", async () => {
    const cells = recorded()
    linkFilm(12, cells)
    await playTheLinesOut(cells)
    await wait(1_000)
    expect(getQueueState()).toMatchObject({ kind: "playing" })
    // The film pane reports it could not be loaded.
    setProgrammeFilm(null)
    expect(getQueueState().kind).toBe("idle")
    expect(ranOut).toBe(1)
  })

  it("a film shorter than the lines: ends at the last line's end, and reports the lines' length", async () => {
    const cells = recorded()
    linkFilm(3, cells)
    startQueue(ctxFor(cells), 0)
    await wait()
    expect(getQueueProgress().duration).toBeCloseTo(5, 5)
    el("b1")!.tick(2)
    await wait()
    el("b2")!.tick(3)
    await wait()
    expect(getQueueState().kind).toBe("idle")
    expect(ranOut).toBe(1)
  })

  it("a seek past the end with no film lands on the last line's final moment", async () => {
    startQueueAtTime(ctxFor(recorded()), 9, { play: false })
    await wait()
    expect(getQueueState()).toMatchObject({ kind: "paused", cellId: "b2" })
    expect(getQueueProgress().currentTime).toBeCloseTo(5, 2)
  })

  it("following the source: the film's length changes nothing the queue does", async () => {
    const cells = recorded()
    linkFilm(12, cells)
    setQueueTimingMode("dubbing")
    startQueue(ctxFor(cells), 0)
    await wait()
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b1" })
    // The take's own clock and length, as ever.
    expect(getQueueProgress().programmeClock).toBe(false)
    expect(getQueueProgress().duration).not.toBeCloseTo(12, 5)
    // Its last line ends the run.
    el("b1")!.onended?.()
    await wait()
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b2" })
    el("b2")!.onended?.()
    await wait()
    expect(getQueueState().kind).toBe("idle")
    await wait(20_000)
    expect(getQueueState().kind).toBe("idle")
  })

  it("a run of only some of the file's lines (a selection) stops at the end of those lines", async () => {
    const cells = [...recorded(), line("b3", 1_000)]
    linkFilm(12, cells)
    // b1 and b2 only.
    await playTheLinesOut(cells.slice(0, 2))
    expect(getQueueState().kind).toBe("idle")
    expect(ranOut).toBe(1)
  })

  it("one line played on its own stops at its end", async () => {
    const cells = recorded()
    linkFilm(12, cells)
    startQueue(ctxFor([cells[1]], { snapshot: true }), 0)
    await wait()
    el("b2")!.tick(3)
    await wait()
    expect(getQueueState().kind).toBe("idle")
  })

  it("another file's lines are not this film's", async () => {
    const cells = recorded()
    setProgrammeFilm({ endSec: 12, cellIds: new Set(["x1", "x2"]) })
    await playTheLinesOut(cells)
    expect(getQueueState().kind).toBe("idle")
  })
})

describe("a take on another track running on past the last line (AQU-2252), beside a film", () => {
  // b2's Track 1 take is a layer of 5 s from b2's start: to 7 s, 2 s past the
  // lines' end at 5 s.
  const layered = () => [line("b1", 2_000), line("b2", 3_000, 5_000)]
  beforeEach(() => {
    setQueueTargetSlots(["recording", TRACK])
    setQueueLayerTrackSlots([TRACK])
  })

  it("with no film it plays out to its own end, as before", async () => {
    await playTheLinesOut(layered())
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b2" })
    expect(getQueueProgress().duration).toBeCloseTo(7, 5)
    expect(el("b2-track")!.paused).toBe(false)
    await wait(2_050)
    expect(getQueueState().kind).toBe("idle")
  })

  it("with a longer film the run goes on to the film's end", async () => {
    const cells = layered()
    linkFilm(12, cells)
    await playTheLinesOut(cells)
    expect(getQueueProgress().duration).toBeCloseTo(12, 5)
    expect(el("b2-track")!.paused).toBe(false)
    await wait(2_050)
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b2" })
    await wait(5_000)
    expect(getQueueState().kind).toBe("idle")
  })

  it("with a film that ends before it, the run goes on to the take's end", async () => {
    const cells = layered()
    linkFilm(6, cells)
    await playTheLinesOut(cells)
    expect(getQueueProgress().duration).toBeCloseTo(7, 5)
    await wait(1_500)
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b2" })
    await wait(550)
    expect(getQueueState().kind).toBe("idle")
  })
})

describe("nothing recorded yet, Skip lines with nothing to play ON (the default)", () => {
  // Three stand-ins of 1.5 s: [0, 1.5), [1.5, 3), [3, 4.5).
  const unrecorded = () => [line("b1"), line("b2"), line("b3")]

  it("with no film there is nothing to play, as before", async () => {
    startQueue(ctxFor(unrecorded()), 0)
    await wait()
    expect(getQueueState().kind).toBe("idle")
  })

  it("with a linked film, Play runs the film: across the lines and on to the film's end", async () => {
    const cells = unrecorded()
    linkFilm(10, cells)
    startQueue(ctxFor(cells), 0)
    await wait()
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b1" })
    expect(getQueueProgress().currentTime).toBeCloseTo(0, 2)
    expect(getQueueProgress().duration).toBeCloseTo(10, 5)

    // The film is not cut: the clock runs straight across each line.
    await wait(2_000)
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b2" })
    expect(getQueueProgress().currentTime).toBeCloseTo(2, 1)
    await wait(2_000)
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b3" })
    // Past the last line, at 4.5 s, and on.
    await wait(2_000)
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b3" })
    expect(getQueueProgress().currentTime).toBeCloseTo(6, 1)
    await wait(4_050)
    expect(getQueueState().kind).toBe("idle")
    expect(ranOut).toBe(1)
  })

  it("Space with nothing selected (Play from the start) runs it too", async () => {
    const cells = unrecorded()
    linkFilm(10, cells)
    startQueueAtTime(ctxFor(cells), 0, { play: true })
    await wait(1_000)
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b1" })
    expect(getQueueProgress().currentTime).toBeCloseTo(1, 1)
  })

  it("Play from a click on a line starts the film there", async () => {
    const cells = unrecorded()
    linkFilm(10, cells)
    startQueueAtTime(ctxFor(cells), 2, { play: false })
    await wait()
    expect(getQueueState()).toMatchObject({ kind: "paused", cellId: "b2" })
    await resumeQueue()
    await wait(500)
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b2" })
    expect(getQueueProgress().currentTime).toBeCloseTo(2.5, 1)
  })

  it("a film shorter than the lines plays to about its end and stops: the lines after it are still skipped", async () => {
    const cells = unrecorded()
    linkFilm(2, cells)
    startQueue(ctxFor(cells), 0)
    await wait()
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b1" })
    // b2 starts at 1.5 s, while the film still runs; b3 starts after its end.
    await wait(1_600)
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b2" })
    await wait(1_500)
    expect(getQueueState().kind).toBe("idle")
  })

  // AQU-2253 (Sam, Nov 9): this test pinned the jump ("once a line is
  // recorded, lines with nothing to play are skipped as before"). The film is
  // the lines' source, so with a line recorded they are played all the same.
  it("once a line is recorded, the lines with nothing of their own still play with the film: nothing is skipped", async () => {
    // b1 a stand-in [0, 1.5); b2 recorded 3 s [1.5, 4.5); b3 a stand-in [4.5, 6).
    const cells = [line("b1"), line("b2", 3_000), line("b3")]
    linkFilm(10, cells)
    startQueue(ctxFor(cells), 0)
    await wait()
    // Not straight to the recorded line: b1 plays, on the film's clock.
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b1" })
    expect(getQueueProgress().currentTime).toBeCloseTo(0, 2)
    expect(getQueueProgress().filmClock).toBe(true)
    await wait(1_600)
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b2" })
    expect(el("b2")!.paused).toBe(false)
    el("b2")!.tick(3)
    await wait()
    // b3 is crossed in real time with the film, from 4.5 s, not jumped to 6 s.
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b3" })
    expect(getQueueProgress().currentTime).toBeCloseTo(4.5, 1)
    await wait(1_000)
    expect(getQueueProgress().currentTime).toBeCloseTo(5.5, 1)
    await wait(4_550)
    expect(getQueueState().kind).toBe("idle")
    expect(ranOut).toBe(1)
  })
})

describe("nothing recorded yet, Skip lines with nothing to play OFF", () => {
  beforeEach(() => setSkipSilentLinesPref(false))

  it("the lines are played through as before, then the film's tail", async () => {
    const cells = [line("b1"), line("b2")]
    linkFilm(6, cells)
    startQueue(ctxFor(cells), 0)
    await wait()
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b1" })
    await wait(3_500)
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b2" })
    expect(getQueueProgress().currentTime).toBeCloseTo(3.5, 1)
    await wait(2_550)
    expect(getQueueState().kind).toBe("idle")
  })

  it("a film shorter than the lines: every line is still played through, to the lines' end", async () => {
    const cells = [line("b1"), line("b2"), line("b3")]
    linkFilm(2, cells)
    startQueue(ctxFor(cells), 0)
    await wait(3_500)
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b3" })
    await wait(1_050)
    expect(getQueueState().kind).toBe("idle")
  })
})

// AQU-2253 (review, Nov 9), finding 2: over the film's tail, and for the whole
// run when nothing is recorded, the playhead ran on a timer that never waited
// for the film. A film that was buffering was skipped forward to the timer,
// and one the browser refused to start was run past, to the end, behind
// "Click to start". The film is the clock there now.
describe("where only the film plays, the film is the clock", () => {
  const unrecorded = () => [line("b1"), line("b2"), line("b3")]

  it("says so over the tail and when nothing is recorded, and not under a recorded line", async () => {
    const cells = recorded()
    linkFilm(12, cells)
    startQueue(ctxFor(cells), 0)
    await wait()
    expect(getQueueProgress().filmClock).toBe(false)
    el("b1")!.tick(2)
    await wait()
    el("b2")!.tick(3)
    await wait()
    expect(getQueueProgress().filmClock).toBe(true)
    stopQueue()

    const none = unrecorded()
    linkFilm(10, none)
    startQueue(ctxFor(none), 0)
    await wait()
    expect(getQueueProgress().filmClock).toBe(true)
  })

  it("over the tail, a film that is buffering holds the playhead where it is and the transport says loading; it carries on when the film does", async () => {
    const cells = recorded()
    linkFilm(12, cells)
    await playTheLinesOut(cells)
    await wait(1_000)
    expect(getQueueProgress().currentTime).toBeCloseTo(6, 1)

    film.stuck = true
    await wait(5_000)
    // Not run on to 11 s over a film that is not playing.
    expect(getQueueProgress().currentTime).toBeCloseTo(6, 1)
    expect(getQueueState()).toMatchObject({ kind: "loading", cellId: "b2" })
    expect(ranOut).toBe(0)

    film.stuck = false
    await wait(1_000)
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b2" })
    expect(getQueueProgress().currentTime).toBeCloseTo(7, 1)
  })

  it("a film that never starts never reaches the end: the run waits, and a pause while it waits is a pause", async () => {
    const cells = recorded()
    linkFilm(12, cells)
    film.stuck = true
    await playTheLinesOut(cells)
    // Longer than the whole tail.
    await wait(30_000)
    expect(getQueueState()).toMatchObject({ kind: "loading", cellId: "b2" })
    expect(getQueueProgress().currentTime).toBeCloseTo(5, 1)
    expect(ranOut).toBe(0)

    pauseQueue()
    expect(getQueueState()).toMatchObject({ kind: "paused", cellId: "b2" })
    await wait(5_000)
    expect(getQueueState()).toMatchObject({ kind: "paused" })
    expect(getQueueProgress().currentTime).toBeCloseTo(5, 1)
  })

  // AQU-2253 (review 2, Nov 9): within the patience. Past it (3 s), the rest
  // of the line is crossed on the queue's own timer, never waited on for good
  // ("a film that says nothing while it is the clock on a line", below).
  it("nothing recorded: the playhead does not leave the start until the film plays", async () => {
    const cells = unrecorded()
    linkFilm(10, cells)
    film.stuck = true
    startQueue(ctxFor(cells), 0)
    await wait(2_500)
    // Not two lines on, over a film still loading.
    expect(getQueueState()).toMatchObject({ kind: "loading", cellId: "b1" })
    expect(getQueueProgress().currentTime).toBeCloseTo(0, 2)

    film.stuck = false
    await wait(2_000)
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b2" })
    expect(getQueueProgress().currentTime).toBeCloseTo(2, 1)
  })

  it("the playhead is where the film is: a film a little ahead is taken up, one a little behind is waited for", async () => {
    const cells = recorded()
    linkFilm(12, cells)
    await playTheLinesOut(cells)
    // The panel's film, a third of a second ahead of the lines' end.
    tickProgrammeFilm(5.3)
    expect(getQueueProgress().currentTime).toBeCloseTo(5.3, 5)
    // An older report (behind the clock) never takes the playhead back.
    tickProgrammeFilm(5.1)
    expect(getQueueProgress().currentTime).toBeCloseTo(5.3, 5)
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b2" })
  })

  it("the run ends when the film reaches its end, not when a timer says it should have", async () => {
    const cells = recorded()
    linkFilm(12, cells)
    await playTheLinesOut(cells)
    // The film lost four seconds to buffering on the way.
    await wait(2_000)
    film.stuck = true
    await wait(4_000)
    film.stuck = false
    await wait(3_000)
    // 7 s of wall time since the lines ended would have been the timer's end.
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b2" })
    expect(getQueueProgress().currentTime).toBeCloseTo(10, 1)
    await wait(2_050)
    expect(getQueueState().kind).toBe("idle")
    expect(ranOut).toBe(1)
  })

  it("a film that turns out shorter than its stored length ends the run when it says it is over", async () => {
    const cells = recorded()
    linkFilm(12, cells)
    await playTheLinesOut(cells)
    await wait(1_000)
    film.stuck = true
    tickProgrammeFilm(6.2, true)
    expect(getQueueState().kind).toBe("idle")
    expect(ranOut).toBe(1)
  })

  it("the film taken away while it carries the lines does not leave the run waiting on it", async () => {
    const cells = unrecorded()
    linkFilm(10, cells)
    startQueue(ctxFor(cells), 0)
    await wait(500)
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b1" })
    setProgrammeFilm(null)
    await wait(5_000)
    expect(getQueueState().kind).toBe("idle")
  })

  // AQU-2253 (Sam, Nov 9): this test pinned the jump ("b2 has nothing and is
  // skipped" once b3 was recorded). b2 has the film behind it, so it plays.
  it("a take landing while the film carries the lines: the lines with nothing go on playing with the film, then the take", async () => {
    const cells = unrecorded()
    linkFilm(10, cells)
    startQueue(ctxFor(cells), 0)
    await wait(500)
    expect(getQueueProgress().filmClock).toBe(true)
    // b3 is recorded now.
    updateQueueCells([line("b1"), line("b2"), line("b3", 2_000)])
    await wait(1_100)
    // b1 and b2 are still the film's to play: on, not skipped.
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b2" })
    expect(getQueueProgress().currentTime).toBeGreaterThanOrEqual(1.5)
    expect(getQueueProgress().filmClock).toBe(true)
    // b3 plays at its own place, 3 s.
    await wait(1_500)
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b3" })
    expect(el("b3")!.paused).toBe(false)
    expect(getQueueProgress().filmClock).toBe(false)
  })

  it("a take landing on the very line the film is carrying: the rest of that line is crossed on the queue's own clock", async () => {
    const cells = unrecorded()
    linkFilm(10, cells)
    startQueue(ctxFor(cells), 0)
    await wait(500)
    updateQueueCells([line("b1", 2_000), line("b2"), line("b3")])
    await wait(300)
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b1" })
    expect(getQueueProgress().filmClock).toBe(false)
    // Not left waiting on the film: b1 (2 s now) ends, b2 plays with the film.
    film.stuck = true
    await wait(1_300)
    expect(getQueueState()).toMatchObject({ cellId: "b2" })
  })

  it("a take on another track still playing out after the last line keeps its own clock, then the film's takes over", async () => {
    setQueueTargetSlots(["recording", TRACK])
    setQueueLayerTrackSlots([TRACK])
    // b2's Track 1 take runs to 7 s, 2 s past the lines' end; the film to 12 s.
    const cells = [line("b1", 2_000), line("b2", 3_000, 5_000)]
    linkFilm(12, cells)
    await playTheLinesOut(cells)
    expect(getQueueProgress().filmClock).toBe(false)
    film.stuck = true
    await wait(2_050)
    // The take has played out on the queue's own clock; from here the film's.
    expect(getQueueProgress().filmClock).toBe(true)
    await wait(3_000)
    expect(getQueueState()).toMatchObject({ kind: "loading", cellId: "b2" })
    expect(getQueueProgress().currentTime).toBeCloseTo(7, 1)
  })
})

// AQU-2253 (review, Nov 9), finding 6: with nothing recorded, a change of
// speed in the middle of a line left the playhead at the old speed until the
// line's end while the film changed at once, so the film was pulled back (or
// pushed on) to the playhead again and again. The playhead takes the new speed
// at once, on every clock it can be held on.
describe("a change of speed in the middle of a line with nothing to play", () => {
  // Three stand-ins of 1.5 s: [0, 1.5), [1.5, 3), [3, 4.5).
  const unrecorded = () => [line("b1"), line("b2"), line("b3")]

  it("nothing recorded, a linked film: the playhead is the film's, so it is at the new speed at once", async () => {
    const cells = unrecorded()
    linkFilm(10, cells)
    startQueue(ctxFor(cells), 0)
    await wait(500)
    expect(getQueueProgress().currentTime).toBeCloseTo(0.5, 1)
    setQueueRate(2)
    // Half a second at double speed is a second of film: 1.5 s, not 1.0 s.
    await wait(500)
    expect(getQueueProgress().currentTime).toBeCloseTo(1.5, 1)
    await wait(500)
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b2" })
    expect(getQueueProgress().currentTime).toBeCloseTo(2.5, 1)
  })

  it("the same with Skip lines with nothing to play off", async () => {
    setSkipSilentLinesPref(false)
    const cells = unrecorded()
    linkFilm(10, cells)
    startQueue(ctxFor(cells), 0)
    await wait(500)
    setQueueRate(2)
    await wait(500)
    expect(getQueueProgress().currentTime).toBeCloseTo(1.5, 1)
  })

  it("with no film, a line crossed in silence (the setting off) takes the new speed at once too", async () => {
    setSkipSilentLinesPref(false)
    startQueue(ctxFor(unrecorded()), 0)
    await wait(500)
    expect(getQueueProgress().currentTime).toBeCloseTo(0.5, 1)
    setQueueRate(2)
    await wait(300)
    expect(getQueueProgress().currentTime).toBeCloseTo(1.1, 1)
    // b1 ends 0.5 s after the change, not a full second after.
    await wait(250)
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b2" })
    // And slower: b2's 1.5 s take 3 s from here.
    setQueueRate(0.5)
    await wait(2_000)
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b2" })
    await wait(1_100)
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b3" })
  })

  // AQU-2253 (Sam, Nov 9): this test pinned the film following the queue's
  // timer over a line with nothing between recorded ones. Only the film plays
  // there, so the film is the clock, as across the lines with nothing recorded.
  it("a line with nothing between recorded ones, under a film: the film is the clock there, so it is at the new speed at once", async () => {
    // b1 recorded 2 s [0, 2); b2 a stand-in [2, 3.5); b3 recorded 1 s [3.5, 4.5).
    const cells = [line("b1", 2_000), line("b2"), line("b3", 1_000)]
    linkFilm(10, cells)
    startQueue(ctxFor(cells), 0)
    await wait()
    el("b1")!.tick(2)
    await wait(500)
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b2" })
    expect(getQueueProgress().filmClock).toBe(true)
    expect(getQueueProgress().currentTime).toBeCloseTo(2.5, 1)
    setQueueRate(2)
    await wait(500)
    expect(getQueueProgress().currentTime).toBeCloseTo(3.5, 1)
  })
})

// AQU-2253 (review, Nov 9), finding 7: a take that lands while the film is
// playing out, and makes the lines longer than where the playhead is. The
// run was neither one thing nor the other: it kept its tail's clock but said
// it was on a line again (the last line's caption came back), ran over the
// new take in silence, and Pause then Play jumped to the start of a line.
// The run carries on as the tail it already is; the take is heard on the
// next Play, from where the playhead is.
describe("a take landing over the film's tail that makes the lines longer than the playhead", () => {
  // b1 [0, 2), b2 [2, 5), and then b3 arrives: 9 s, [5, 14). The film is 20 s.
  const withB3 = () => [...recorded(), line("b3", 9_000)]
  /** Play the lines out, 2 s of the film's tail (7 s), then b3 lands. */
  async function tailThenTake(): Promise<void> {
    const cells = recorded()
    linkFilm(20, cells)
    await playTheLinesOut(cells)
    await wait(2_000)
    expect(getQueueProgress().currentTime).toBeCloseTo(7, 1)
    // The bar hands the queue the lines; the workspace names them for the film.
    updateQueueCells(withB3())
    linkFilm(20, withB3())
  }

  it("the run carries on as the film's tail: on the film's clock, no line shown as playing, to the film's end", async () => {
    await tailThenTake()
    await wait(3_000)
    expect(getQueueState()).toMatchObject({ kind: "playing" })
    expect(getQueueProgress().currentTime).toBeCloseTo(10, 1)
    expect(getQueueProgress().filmClock).toBe(true)
    // Still the tail: no caption comes back, no row is shown as playing.
    expect(getQueueProgress().filmTail).toBe(true)
    // The take is not started in the middle, and nothing else sounds.
    expect(anythingSounding()).toBe(false)
    await wait(10_050)
    expect(getQueueState().kind).toBe("idle")
    expect(ranOut).toBe(1)
  })

  it("the new take is heard on the next Play, from where the playhead is", async () => {
    await tailThenTake()
    await wait(1_000)
    pauseQueue()
    expect(getQueueProgress().currentTime).toBeCloseTo(8, 1)
    await resumeQueue()
    await wait()
    // 8 s is 3 s into b3: that line plays, from there.
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b3" })
    expect(el("b3")!.paused).toBe(false)
    expect(el("b3")!.currentTime).toBeCloseTo(3, 1)
    expect(getQueueProgress().filmTail).toBe(false)
    expect(getQueueProgress().filmClock).toBe(false)
  })

  it("a take that makes the last line itself longer: the same, and Play plays that line from the playhead", async () => {
    const cells = recorded()
    linkFilm(20, cells)
    await playTheLinesOut(cells)
    await wait(2_000)
    // b2 re-recorded: 9 s, [2, 11). The playhead, at 7 s, is inside it.
    const longer = [line("b1", 2_000), line("b2", 9_000)]
    updateQueueCells(longer)
    linkFilm(20, longer)
    await wait(1_000)
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b2" })
    expect(getQueueProgress().currentTime).toBeCloseTo(8, 1)
    expect(getQueueProgress().filmTail).toBe(true)
    expect(anythingSounding()).toBe(false)
    pauseQueue()
    await resumeQueue()
    await wait()
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b2" })
    expect(getQueueProgress().filmTail).toBe(false)
    expect(anythingSounding()).toBe(true)
  })

  it("the film taken away then ends the run there, as over any tail", async () => {
    await tailThenTake()
    await wait(1_000)
    setProgrammeFilm(null)
    expect(getQueueState().kind).toBe("idle")
    expect(ranOut).toBe(1)
  })

  it("previous line goes back to the line the tail followed", async () => {
    await tailThenTake()
    await wait(1_000)
    skipBack()
    await wait()
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b2" })
    expect(getQueueProgress().currentTime).toBeCloseTo(2, 2)
  })
})

// AQU-2253 (review, Nov 9), finding 3: switching to another file while the
// first one's film played out left the queue running on the first file,
// unseen, until that film's length had passed, and going back to it started
// its film again with no press. The workspace says which file is on screen
// with its word about the film; a run the film is the clock of ends at once
// when another file comes on screen, whatever that file is.
describe("switching to another file while the film plays", () => {
  const unrecorded = () => [line("b1"), line("b2"), line("b3")]
  const filmOf = (endSec: number, cells: CellData[]) => ({ endSec, cellIds: new Set(cells.map((c) => c.id)) })
  /** Episode 1 ("f1"): its lines played out, a second of its 60 s film's tail. */
  async function episodeOneOverItsTail(): Promise<CellData[]> {
    const cells = recorded()
    setProgrammeFilm(filmOf(60, cells), "f1")
    await playTheLinesOut(cells)
    await wait(1_000)
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b2" })
    return cells
  }

  it("to a file with its own film: the run ends at once, and going back does not start the film", async () => {
    const cells = await episodeOneOverItsTail()
    // Episode 2 comes on screen, with its own film and lines.
    setProgrammeFilm({ endSec: 45, cellIds: new Set(["x1", "x2"]) }, "f2")
    expect(getQueueState().kind).toBe("idle")
    // A switch is not the lines running out: nothing carries on from it.
    expect(ranOut).toBe(0)
    // Back to episode 1 inside what was left of its film.
    setProgrammeFilm(filmOf(60, cells), "f1")
    await wait(10_000)
    expect(getQueueState().kind).toBe("idle")
    expect(film.reports).toBe(4)
  })

  it("to a file with no film: the same", async () => {
    await episodeOneOverItsTail()
    setProgrammeFilm(null, "f2")
    expect(getQueueState().kind).toBe("idle")
    expect(ranOut).toBe(0)
  })

  it("with nothing recorded, whatever Skip lines with nothing to play says: the run ends at once", async () => {
    for (const skip of [true, false]) {
      setSkipSilentLinesPref(skip)
      const cells = unrecorded()
      setProgrammeFilm(filmOf(60, cells), "f1")
      startQueue(ctxFor(cells), 0)
      await wait(500)
      expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b1" })
      setProgrammeFilm(null, "f2")
      expect(getQueueState().kind).toBe("idle")
      await wait(10_000)
      expect(getQueueState().kind).toBe("idle")
    }
  })

  it("while the film waits (buffering), too", async () => {
    const cells = recorded()
    setProgrammeFilm(filmOf(60, cells), "f1")
    film.stuck = true
    await playTheLinesOut(cells)
    await wait(2_000)
    expect(getQueueState()).toMatchObject({ kind: "loading", cellId: "b2" })
    setProgrammeFilm({ endSec: 45, cellIds: new Set(["x1", "x2"]) }, "f2")
    expect(getQueueState().kind).toBe("idle")
  })

  it("the same file's lines changing is not a switch: the tail plays on", async () => {
    const cells = await episodeOneOverItsTail()
    const more = [line("b0"), ...cells]
    setProgrammeFilm(filmOf(60, more), "f1")
    updateQueueCells(more)
    setProgrammeFilm(filmOf(60, more), "f1")
    await wait(2_000)
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b2" })
    expect(getQueueProgress().currentTime).toBeCloseTo(8, 1)
  })

  it("a run still on its recorded lines is left alone, and ends with its lines as on any file", async () => {
    const cells = recorded()
    setProgrammeFilm(filmOf(60, cells), "f1")
    startQueue(ctxFor(cells), 0)
    await wait()
    setProgrammeFilm({ endSec: 45, cellIds: new Set(["x1", "x2"]) }, "f2")
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b1" })
    el("b1")!.tick(2)
    await wait()
    el("b2")!.tick(3)
    await wait()
    expect(getQueueState().kind).toBe("idle")
  })

  it("paused over the tail, it stays paused there, and is still paused on coming back", async () => {
    const cells = await episodeOneOverItsTail()
    pauseQueue()
    setProgrammeFilm({ endSec: 45, cellIds: new Set(["x1", "x2"]) }, "f2")
    setProgrammeFilm(filmOf(60, cells), "f1")
    await wait(5_000)
    expect(getQueueState()).toMatchObject({ kind: "paused", cellId: "b2" })
    expect(getQueueProgress().currentTime).toBeCloseTo(6, 1)
  })
})

// AQU-2253 (review, Nov 9), finding 5: for the whole of the film's tail the
// last line kept its "playing" ring and tint in the lines table (the caption
// was taken off the picture, the row was not). Over the tail the last line
// stays the current line, where the table and its cursor rest (Sam, Oct 7),
// but it is not shown as playing.
describe("the lines table over the film's tail", () => {
  it("the last line stays the current line and is not shown as playing; back on the line, it is again", async () => {
    const cells = recorded()
    linkFilm(12, cells)
    const shownPlaying = renderHook(() => useIsQueueCurrentCell("b2"))
    const currentLine = renderHook(() => useQueueCurrentCellId())
    const wordClock = renderHook(() => useQueueCellPlayhead("b2"))

    await act(async () => {
      startQueue(ctxFor(cells), 0)
      await wait()
      el("b1")!.tick(2)
      await wait()
    })
    // b2 is the line playing.
    expect(shownPlaying.result.current).toBe(true)
    expect(currentLine.result.current).toBe("b2")

    await act(async () => {
      el("b2")!.tick(3)
      await wait(1_000)
    })
    // Over the tail: still the current line, no ring, no words lit by the clock.
    expect(getQueueProgress().filmTail).toBe(true)
    expect(shownPlaying.result.current).toBe(false)
    expect(currentLine.result.current).toBe("b2")
    expect(wordClock.result.current).toBeNull()

    await act(async () => {
      seekQueueToTime(3, { play: true })
      await wait()
    })
    expect(shownPlaying.result.current).toBe(true)
    expect(wordClock.result.current).not.toBeNull()
  })

  it("a take on another track playing out after the last line, with no film: the last line is still shown as playing", async () => {
    setQueueTargetSlots(["recording", TRACK])
    setQueueLayerTrackSlots([TRACK])
    const shownPlaying = renderHook(() => useIsQueueCurrentCell("b2"))
    await act(async () => {
      await playTheLinesOut([line("b1", 2_000), line("b2", 3_000, 5_000)])
      await wait(500)
    })
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b2" })
    expect(shownPlaying.result.current).toBe(true)
  })
})

// AQU-2253 (Sam, Nov 9): "the rule 'skip lines with nothing to play' should
// only land when there is literally nothing to play: recorded or source." On
// a file with a linked film, the film is the source. A browser pass showed a
// partly recorded file with Skip on: lines 1 and 2 played, then the playhead
// jumped from 10.2 s to 24.9 s and the film cut forward with it. Now a line
// with nothing of its own that the film plays behind is played: the playhead
// crosses it in real time with the film running, and nothing is jumped.
describe("Skip lines with nothing to play lands only where there is nothing at all (Sam, Nov 9)", () => {
  // b1 recorded 2 s [0, 2); b2 recorded 3 s [2, 5); b3..b6 not recorded, 1.5 s
  // stand-ins: [5, 6.5), [6.5, 8), [8, 9.5), [9.5, 11). The film is 20 s.
  const partly = () => [...recorded(), line("b3"), line("b4"), line("b5"), line("b6")]

  describe("1. a line is skipped only when it has no recording and no source", () => {
    it("with no film, a line with nothing between two recorded ones is still skipped (Skip on)", async () => {
      // b1 [0, 2); b2 a stand-in [2, 3.5); b3 recorded 1 s [3.5, 4.5).
      startQueue(ctxFor([line("b1", 2_000), line("b2"), line("b3", 1_000)]), 0)
      await wait()
      el("b1")!.tick(2)
      await wait()
      expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b3" })
      expect(getQueueProgress().currentTime).toBeCloseTo(3.5, 2)
    })
  })

  describe("2. on a file with a linked film, the film is the source: Skip never jumps there", () => {
    it("the lines recorded play, the ones not recorded are crossed in real time with the film, on to the film's end", async () => {
      const cells = partly()
      linkFilm(20, cells)
      await playTheLinesOut(cells)
      // b2 is over at 5 s: no jump to 11 s.
      expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b3" })
      expect(getQueueProgress().currentTime).toBeCloseTo(5, 1)
      expect(getQueueProgress().filmClock).toBe(true)
      expect(getQueueProgress().filmTail).toBe(false)
      // Only the film plays there.
      expect(anythingSounding()).toBe(false)
      await wait(1_000)
      expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b3" })
      expect(getQueueProgress().currentTime).toBeCloseTo(6, 1)
      await wait(1_500)
      expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b4" })
      expect(getQueueProgress().currentTime).toBeCloseTo(7.5, 1)
      await wait(3_750)
      // 11.25 s: past the last line, the film's tail.
      expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b6" })
      expect(getQueueProgress().filmTail).toBe(true)
      expect(getQueueProgress().duration).toBeCloseTo(20, 5)
      expect(ranOut).toBe(0)
      await wait(8_800)
      expect(getQueueState().kind).toBe("idle")
      expect(ranOut).toBe(1)
    })

    it("the playhead never goes backwards or jumps across the whole run", async () => {
      const cells = partly()
      linkFilm(20, cells)
      startQueue(ctxFor(cells), 0)
      await wait()
      el("b1")!.tick(2)
      await wait()
      el("b2")!.tick(3)
      let last = getQueueProgress().currentTime
      for (let i = 0; i < 60; i++) {
        await wait(250)
        const now = getQueueProgress().currentTime
        expect(now).toBeGreaterThanOrEqual(last - 0.001)
        expect(now - last).toBeLessThan(0.6)
        last = now
        if (getQueueState().kind === "idle") break
      }
    })

    it("a click on a line with nothing recorded, then Play, plays from there (it is not jumped)", async () => {
      const cells = partly()
      linkFilm(20, cells)
      startQueueAtTime(ctxFor(cells), 7, { play: false })
      await wait()
      expect(getQueueState()).toMatchObject({ kind: "paused", cellId: "b4" })
      expect(getQueueProgress().currentTime).toBeCloseTo(7, 5)
      await resumeQueue()
      await wait(500)
      expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b4" })
      expect(getQueueProgress().currentTime).toBeCloseTo(7.5, 1)
    })

    it("Next line goes to the next line, recorded or not; Previous line back to the one before", async () => {
      const cells = partly()
      linkFilm(20, cells)
      startQueue(ctxFor(cells), 0)
      await wait()
      el("b1")!.tick(1)
      skipForward()
      await wait()
      expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b2" })
      skipForward()
      await wait()
      expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b3" })
      expect(getQueueProgress().currentTime).toBeCloseTo(5, 1)
      skipForward()
      await wait()
      expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b4" })
      skipBack()
      await wait()
      expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b3" })
    })

    it("the line crossed is the line shown as playing", async () => {
      const cells = partly()
      linkFilm(20, cells)
      const shownPlaying = renderHook(() => useIsQueueCurrentCell("b3"))
      await act(async () => {
        await playTheLinesOut(cells)
        await wait(500)
      })
      expect(shownPlaying.result.current).toBe(true)
      expect(getQueueProgress().filmTail).toBe(false)
    })

    it("whichever way the setting is, the run is the same", async () => {
      const trace = async (skip: boolean): Promise<string[]> => {
        setSkipSilentLinesPref(skip)
        const cells = partly()
        linkFilm(20, cells)
        await playTheLinesOut(cells)
        const seen: string[] = []
        for (let i = 0; i < 8; i++) {
          seen.push(`${getQueueState().kind}:${(getQueueState() as { cellId?: string }).cellId}:${getQueueProgress().currentTime.toFixed(1)}`)
          await wait(1_000)
        }
        stopQueue()
        film.sec = 0
        return seen
      }
      const on = await trace(true)
      const off = await trace(false)
      expect(off).toEqual(on)
      expect(on[1]).toBe("playing:b3:6.0")
    })
  })

  describe("3. a film whose sound is off still counts: its picture is running", () => {
    it("with the film's sound row muted and the strip at no volume, the lines with nothing are still crossed, not jumped", async () => {
      setQueueAudibility({ source: false, target: true })
      setQueueVolume(0)
      try {
        const cells = partly()
        linkFilm(20, cells)
        await playTheLinesOut(cells)
        expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b3" })
        expect(getQueueProgress().currentTime).toBeCloseTo(5, 1)
        await wait(1_000)
        expect(getQueueProgress().currentTime).toBeCloseTo(6, 1)
      } finally {
        setQueueAudibility({ source: true, target: true })
        setQueueVolume(1)
      }
    })
  })

  describe("4. in the middle of the file too", () => {
    it("a line with nothing between two recorded ones is crossed with the film, then the next one plays", async () => {
      // b1 recorded 2 s [0, 2); b2 a stand-in [2, 3.5); b3 recorded 1 s [3.5, 4.5).
      const cells = [line("b1", 2_000), line("b2"), line("b3", 1_000)]
      linkFilm(10, cells)
      startQueue(ctxFor(cells), 0)
      await wait()
      el("b1")!.tick(2)
      await wait()
      expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b2" })
      expect(getQueueProgress().currentTime).toBeCloseTo(2, 1)
      await wait(1_000)
      expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b2" })
      expect(getQueueProgress().currentTime).toBeCloseTo(3, 1)
      await wait(750)
      expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b3" })
      expect(el("b3")!.paused).toBe(false)
      expect(getQueueProgress().filmClock).toBe(false)
    })

    it("a hidden line with nothing left to play there is crossed with the film too, its take silent", async () => {
      const hidden = { ...line("b2", 4_000), hidden: true } as CellData
      const cells = [line("b1", 2_000), hidden, line("b3", 1_000)]
      linkFilm(12, cells)
      startQueue(ctxFor(cells), 0)
      await wait()
      el("b1")!.tick(2)
      await wait()
      expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b2" })
      expect(getQueueProgress().currentTime).toBeCloseTo(2, 1)
      await wait(1_000)
      expect(getQueueProgress().currentTime).toBeCloseTo(3, 1)
      expect(el("b2")).toBeUndefined()
    })

    it("a line only a take on another track sounds in is that take's, on the queue's own clock; the line after it is the film's", async () => {
      setQueueTargetSlots(["recording", TRACK])
      setQueueLayerTrackSlots([TRACK])
      // b1 recorded 2 s [0, 2); b2 only a 1 s Track 1 take, a stand-in [2, 3.5); b3 a stand-in [3.5, 5).
      const cells = [line("b1", 2_000), line("b2", undefined, 1_000), line("b3")]
      linkFilm(10, cells)
      startQueue(ctxFor(cells), 0)
      await wait()
      el("b1")!.tick(2)
      await wait()
      expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b2" })
      expect(el("b2-track")!.paused).toBe(false)
      expect(getQueueProgress().filmClock).toBe(false)
      await wait(1_750)
      expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b3" })
      expect(getQueueProgress().filmClock).toBe(true)
    })
  })

  describe("5. what is still skipped: a line with no recording, no original and no film behind it", () => {
    it("a film shorter than the lines: the lines past its end with nothing of their own are skipped, and Play ends with the lines", async () => {
      // The film ends at 6 s, inside b3 [5, 6.5); b4..b6 start after it.
      const cells = partly()
      linkFilm(6, cells)
      await playTheLinesOut(cells)
      expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b3" })
      await wait(1_600)
      expect(getQueueState().kind).toBe("idle")
      expect(ranOut).toBe(1)
    })

    it("a film that could not be loaded is not something to play: the lines with nothing are skipped, as with no film", async () => {
      const cells = partly()
      linkFilm(20, cells)
      startQueue(ctxFor(cells), 0)
      await wait()
      // The film pane reports it could not be loaded.
      setProgrammeFilm(null)
      el("b1")!.tick(2)
      await wait()
      el("b2")!.tick(3)
      await wait()
      expect(getQueueState().kind).toBe("idle")
      expect(ranOut).toBe(1)
    })

    it("the film failing while it carries a line: the rest of that line is crossed, the lines after it are skipped", async () => {
      const cells = partly()
      linkFilm(20, cells)
      await playTheLinesOut(cells)
      await wait(500)
      expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b3" })
      setProgrammeFilm(null)
      await wait(1_100)
      expect(getQueueState().kind).toBe("idle")
    })

    it("with the setting off, the lines past a shorter film's end are played through in silence, as before", async () => {
      setSkipSilentLinesPref(false)
      const cells = partly()
      linkFilm(6, cells)
      await playTheLinesOut(cells)
      await wait(3_000)
      // 8 s: b5, on the queue's own clock (no film there).
      expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b5" })
      expect(getQueueProgress().filmClock).toBe(false)
    })
  })

  describe("6. nothing recorded is the same rule, not a case of its own", () => {
    it("a file's first line recorded later changes nothing about the lines with nothing: they play with the film", async () => {
      for (const cells of [[line("b1"), line("b2"), line("b3")], [line("b1", 1_500), line("b2"), line("b3")]]) {
        linkFilm(10, cells)
        startQueue(ctxFor(cells), 0)
        await wait(1_000)
        el("b1")?.tick(1.5)
        await wait(1_000)
        expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b2" })
        expect(getQueueProgress().filmClock).toBe(true)
        stopQueue()
        film.sec = 0
      }
    })
  })

  describe("the film's length not known yet", () => {
    const unknownFilm = (cells: CellData[]) =>
      setProgrammeFilm({ endSec: null, cellIds: new Set(cells.map((c) => c.id)) })

    it("lines with nothing are not skipped (the film may cover them); Play ends with the lines, and the length is the lines'", async () => {
      const cells = partly()
      unknownFilm(cells)
      startQueue(ctxFor(cells), 0)
      await wait()
      expect(getQueueProgress().duration).toBeCloseTo(11, 5)
      el("b1")!.tick(2)
      await wait()
      el("b2")!.tick(3)
      await wait()
      expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b3" })
      await wait(6_100)
      expect(getQueueState().kind).toBe("idle")
      expect(ranOut).toBe(1)
    })

    it("with nothing recorded, Play runs the film across the lines", async () => {
      const cells = [line("b1"), line("b2")]
      unknownFilm(cells)
      startQueue(ctxFor(cells), 0)
      await wait(2_000)
      expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b2" })
      expect(getQueueProgress().filmClock).toBe(true)
    })

    it("its length arriving while the film carries a line: the run goes on to the film's end", async () => {
      const cells = partly()
      unknownFilm(cells)
      await playTheLinesOut(cells)
      await wait(1_000)
      linkFilm(20, cells)
      expect(getQueueProgress().duration).toBeCloseTo(20, 5)
      await wait(6_000)
      expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b6" })
      expect(getQueueProgress().filmTail).toBe(true)
    })
  })

  describe("one chapter of a book with a linked film", () => {
    // Chapter 1: b1 recorded 2 s, b2 not. Chapter 2: b3 not, b4 recorded 1 s.
    const chapterOne = () => [line("b1", 2_000), line("b2")]
    const chapterTwo = () => [line("b3"), line("b4", 1_000)]
    /** The workspace's word on a book: every chapter's lines, no run-on past a chapter. */
    const bookFilm = (endSec: number | null) =>
      setProgrammeFilm({ endSec, runsOn: false, cellIds: new Set([...chapterOne(), ...chapterTwo()].map((c) => c.id)) })

    it("a line with nothing is crossed with the film; Play ends with the chapter's lines, and the length is the chapter's", async () => {
      bookFilm(60)
      startQueue(ctxFor(chapterOne()), 0)
      await wait()
      expect(getQueueProgress().duration).toBeCloseTo(3.5, 5)
      el("b1")!.tick(2)
      await wait()
      expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b2" })
      expect(getQueueProgress().filmClock).toBe(true)
      await wait(1_600)
      expect(getQueueState().kind).toBe("idle")
      expect(ranOut).toBe(1)
    })

    it("the next chapter is the film's at once, before the workspace's next word", async () => {
      bookFilm(60)
      startQueue(ctxFor(chapterTwo()), 0)
      await wait()
      expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b3" })
      expect(getQueueProgress().currentTime).toBeCloseTo(0, 2)
    })

    // AQU-2253 (review 2, Nov 9): two questions. Played by hand, a chapter
    // with nothing recorded has the film to play; Play all's own move into
    // it asks for something of the chapter's own, which it has not.
    it("a chapter with nothing recorded: the film to play when someone asks for it, nothing of its own for Play all", () => {
      const unrecordedChapter = [line("b3"), line("b4")]
      expect(linesHaveAnythingToPlayCountingFilm(unrecordedChapter, null)).toBe(false)
      bookFilm(60)
      expect(linesHaveAnythingToPlayCountingFilm(unrecordedChapter)).toBe(true)
      expect(linesHaveAnythingOfTheirOwnToPlay(unrecordedChapter)).toBe(false)
      // Another file's film does not count.
      expect(linesHaveAnythingToPlayCountingFilm([line("x1")])).toBe(false)
    })
  })
})

// AQU-2253 (review 2, Nov 9), finding 3: under a line with nothing of its own
// the playhead is the film's own report, about four times a second. A report
// that landed past the end of the NEXT line too, where the line after that was
// also the film's, went straight there: a short take in between (a "Yes", a
// laugh) was never heard, and nothing showed it.
describe("a short take between two lines the film carries is played, however the film's reports fall", () => {
  /** The panel's film, reporting by hand: the stand-in stays quiet. */
  const reportsAt = async (secs: number[]) => {
    for (const sec of secs) {
      await wait(250)
      tickProgrammeFilm(sec)
    }
    await wait()
  }

  it("a report landing past a 0.2 s take: the take plays from its start, then the film carries on", async () => {
    // b1 a stand-in [0, 1.5); b2 recorded 0.2 s [1.5, 1.7); b3 a stand-in [1.7, 3.2).
    const cells = [line("b1"), line("b2", 200), line("b3")]
    linkFilm(10, cells)
    film.stuck = true
    startQueue(ctxFor(cells), 0)
    await wait()
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b1" })
    // Uneven steps: the last lands at 1.70, past b2's end.
    await reportsAt([0.2, 0.45, 0.7, 0.95, 1.2, 1.45, 1.7])
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b2" })
    expect(getQueueProgress().currentTime).toBeCloseTo(1.5, 2)
    expect(el("b2")!.paused).toBe(false)
    expect(getQueueProgress().filmClock).toBe(false)
    // The take plays out; the film carries b3.
    el("b2")!.tick(0.2)
    await wait()
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b3" })
    expect(getQueueProgress().filmClock).toBe(true)
  })

  it("at double speed too: a 0.4 s take a report lands past is played", async () => {
    setQueueRate(2)
    // b1 a stand-in [0, 1.5); b2 recorded 0.4 s [1.5, 1.9); b3 a stand-in [1.9, 3.4).
    const cells = [line("b1"), line("b2", 400), line("b3")]
    linkFilm(10, cells)
    film.stuck = true
    startQueue(ctxFor(cells), 0)
    await wait()
    // Half a second of film per beat; the last lands at 1.95.
    await reportsAt([0.45, 0.95, 1.45, 1.95])
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b2" })
    expect(getQueueProgress().currentTime).toBeCloseTo(1.5, 2)
    expect(el("b2")!.paused).toBe(false)
  })

  it("a report landing past two lines the film carries, with nothing recorded between, still goes straight on", async () => {
    // b1 [0, 1.5), b2 [1.5, 3), b3 [3, 4.5): all stand-ins.
    const cells = [line("b1"), line("b2"), line("b3")]
    linkFilm(10, cells)
    film.stuck = true
    startQueue(ctxFor(cells), 0)
    await wait()
    await reportsAt([0.5, 1.0, 3.2])
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b3" })
    expect(getQueueProgress().currentTime).toBeCloseTo(3.2, 2)
  })

  it("the film ending inside a line is not a line passed: the rest of it is crossed, then the take after it plays at its place", async () => {
    // b1 [0, 1.5) and b2 [1.5, 3) stand-ins; b3 recorded 1 s [3, 4). The film is 2 s.
    const cells = [line("b1"), line("b2"), line("b3", 1_000)]
    linkFilm(2, cells)
    film.stuck = true
    startQueue(ctxFor(cells), 0)
    await wait()
    await reportsAt([0.5, 1.0, 1.5, 1.75])
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b2" })
    expect(getQueueProgress().currentTime).toBeCloseTo(1.75, 1)
    await wait(950)
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b2" })
    await wait(400)
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b3" })
  })
})

// AQU-2253 (review 2, Nov 9), finding 1: on a book with a linked film every
// chapter had the film to play, so Play all ran the whole book, recorded or
// not, and each chapter, running on its own clock from 0:00, put the film back
// to its opening. Play all's own move into the next chapter now goes on only
// into a chapter with something of its own to play (a take or an original);
// a chapter only the film could play ends Play all there, as before. Playing
// a chapter by hand is unchanged: the film is behind its lines.
describe("Play all on a book with a linked film goes on only into a chapter with something of its own", () => {
  // Three chapters of two 1.5 s stand-ins each, unless recorded.
  const CHAPTERS: TimelineChapter[] = [
    { key: "LUK 1", cellIds: ["c1a", "c1b"] },
    { key: "LUK 2", cellIds: ["c2a", "c2b"] },
    { key: "LUK 3", cellIds: ["c3a", "c3b"] },
  ]
  let book: CellData[] = []
  let chaptersStarted: string[] = []
  let stopPlayAll: () => void = () => {}

  /** The book, and the workspace's word: the film named with every chapter's
   *  lines, running on past none. */
  function bookWith(lines: CellData[], filmSec: number): void {
    book = lines
    setProgrammeFilm({ endSec: filmSec, runsOn: false, cellIds: new Set(lines.map((c) => c.id)) })
  }
  const chapter = (key: string) => scopeCells(book, CHAPTERS.find((c) => c.key === key)!)

  beforeEach(() => {
    chaptersStarted = []
    // What ProjectWorkspace's `onQueueRanOut` does when a chapter's run plays out.
    stopPlayAll = onQueueRanOut((ctx) => {
      const played = chapterOfCell(CHAPTERS, ctx.cells[0]?.id)
      if (!played) return
      const next = nextChapterForPlayAll({ chapters: CHAPTERS, lines: book, playedKey: played.key })
      if (!next) return
      chaptersStarted.push(next.key)
      queueMicrotask(() => startQueue({ ...ctx, cells: scopeCells(book, next) }, 0))
    })
  })
  afterEach(() => stopPlayAll())

  it("A. nothing recorded: the chapter Play was pressed on plays with the film, and Play all stops after it", async () => {
    bookWith(["c1a", "c1b", "c2a", "c2b", "c3a", "c3b"].map((id) => line(id)), 600)
    // Play is offered on the chapter: the film is behind its lines.
    expect(linesHaveAnythingToPlayCountingFilm(chapter("LUK 1"))).toBe(true)
    startQueue(ctxFor(chapter("LUK 1")), 0)
    await wait(1_000)
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "c1a" })
    expect(getQueueProgress().filmClock).toBe(true)
    await wait(2_500)
    // Chapter 1's 3 s are over: no chapter 2 from 0:00 of the film again.
    expect(getQueueState().kind).toBe("idle")
    expect(chaptersStarted).toEqual([])
    await wait(10_000)
    expect(getQueueState().kind).toBe("idle")
  })

  it("A. …and pressed on a later chapter, that one plays and Play all stops after it", async () => {
    bookWith(["c1a", "c1b", "c2a", "c2b", "c3a", "c3b"].map((id) => line(id)), 600)
    startQueue(ctxFor(chapter("LUK 2")), 0)
    await wait(1_000)
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "c2a" })
    await wait(2_500)
    expect(getQueueState().kind).toBe("idle")
    expect(chaptersStarted).toEqual([])
  })

  it("B. a film shorter than the chapter, nothing recorded: the chapter plays to the film's end, its lines past it skipped, and Play all stops", async () => {
    // A 1 s film: c1a [0, 1.5) starts under it, c1b [1.5, 3) after its end.
    bookWith(["c1a", "c1b", "c2a", "c2b", "c3a", "c3b"].map((id) => line(id)), 1)
    startQueue(ctxFor(chapter("LUK 1")), 0)
    await wait(500)
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "c1a" })
    await wait(1_100)
    expect(getQueueState().kind).toBe("idle")
    expect(chaptersStarted).toEqual([])
    await wait(10_000)
    expect(getQueueState().kind).toBe("idle")
  })

  it("C. chapter 1 recorded, the rest not: Play all stops after chapter 1", async () => {
    bookWith([line("c1a", 2_000), line("c1b", 1_000), ...["c2a", "c2b", "c3a", "c3b"].map((id) => line(id))], 600)
    startQueue(ctxFor(chapter("LUK 1")), 0)
    await wait()
    el("c1a")!.tick(2)
    await wait()
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "c1b" })
    el("c1b")!.tick(1)
    await wait()
    expect(getQueueState().kind).toBe("idle")
    expect(chaptersStarted).toEqual([])
    await wait(10_000)
    expect(getQueueState().kind).toBe("idle")
  })

  it("a later chapter with a recording of its own is still gone on into, over one with nothing (as before)", async () => {
    bookWith([line("c1a", 2_000), line("c1b"), line("c2a"), line("c2b"), line("c3a", 1_000), line("c3b")], 600)
    startQueue(ctxFor(chapter("LUK 1")), 0)
    await wait()
    el("c1a")!.tick(2)
    await wait()
    // c1b has nothing of its own: crossed with the film, not jumped.
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "c1b" })
    expect(getQueueProgress().filmClock).toBe(true)
    await wait(1_600)
    expect(chaptersStarted).toEqual(["LUK 3"])
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "c3a" })
    expect(getQueueProgress().currentTime).toBeCloseTo(0, 1)
  })

  it("a chapter whose lines have only their originals is gone on into (the originals rule stays)", () => {
    const SOURCE_ID = "audio-f1-1690000000-shared.mp3"
    const withOriginal = (id: string): CellData =>
      ({
        ...line(id), medium: "media", startTime: 0, endTime: 3,
        attachments: { [SOURCE_ID]: { type: "audio", url: "http://audio.test/clip.mp3" } },
      }) as unknown as CellData
    bookWith([line("c1a", 2_000), line("c1b"), withOriginal("c2a"), line("c2b"), line("c3a"), line("c3b")], 600)
    expect(nextChapterForPlayAll({ chapters: CHAPTERS, lines: book, playedKey: "LUK 1" })?.key).toBe("LUK 2")
  })
})

// AQU-2253 (review 2, Nov 9), finding 2: where the film is the clock on a line,
// only a report from the film moves the playhead on. A film whose length never
// came in was never asked to play by the panel, and Play sat on the first line
// nobody recorded with a spinner, for good. Now the panel asks such a film to
// play (video-sync.test.ts), and the queue has a patience limit: a film that
// has said nothing for 3 s while it is the clock on a line is given up as the
// clock; the rest of that line is crossed on the queue's own timer with the
// film following, as under a recorded line, and so are the later lines, until
// the film is heard from again. The line is never skipped. Over the film's
// tail there is nothing but the film, and the run still waits for it.
describe("a film that says nothing while it is the clock on a line is not waited on for good", () => {
  const unknownFilm = (cells: CellData[]) =>
    setProgrammeFilm({ endSec: null, cellIds: new Set(cells.map((c) => c.id)) })

  it("the reviewer's probe: b1 recorded, b2 not, b3 recorded, a film with no length that never reports: b3 plays", async () => {
    // b1 recorded 1 s [0, 1); b2 a stand-in [1, 2.5); b3 recorded 1 s [2.5, 3.5).
    const cells = [line("b1", 1_000), line("b2"), line("b3", 1_000)]
    unknownFilm(cells)
    film.stuck = true
    startQueue(ctxFor(cells), 0)
    await wait()
    el("b1")!.tick(1)
    await wait()
    expect(getQueueState()).toMatchObject({ cellId: "b2" })
    expect(getQueueProgress().filmClock).toBe(true)
    // Within the patience the playhead waits for the film, as before.
    await wait(2_500)
    expect(getQueueState()).toMatchObject({ kind: "loading", cellId: "b2" })
    expect(getQueueProgress().currentTime).toBeCloseTo(1, 2)
    // Past it: b2 is crossed on the queue's own timer, from where it waited.
    await wait(1_000)
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b2" })
    expect(getQueueProgress().filmClock).toBe(false)
    expect(getQueueProgress().currentTime).toBeGreaterThan(1.2)
    expect(getQueueProgress().currentTime).toBeLessThan(2)
    await wait(1_200)
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b3" })
    expect(el("b3")!.paused).toBe(false)
  })

  it("the lines after it are crossed on the queue's timer at once, until the film is heard from again; then the film is the clock again", async () => {
    // Four stand-ins of 1.5 s: [0, 1.5), [1.5, 3), [3, 4.5), [4.5, 6). A 20 s film.
    const cells = [line("b1"), line("b2"), line("b3"), line("b4")]
    linkFilm(20, cells)
    film.stuck = true
    startQueue(ctxFor(cells), 0)
    await wait(3_250)
    // Given up on at 3 s: b1's rest on the timer.
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b1" })
    expect(getQueueProgress().filmClock).toBe(false)
    await wait(1_500)
    // b2 is not waited for: on the timer from its start, no spinner.
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b2" })
    expect(getQueueProgress().filmClock).toBe(false)
    expect(getQueueProgress().currentTime).toBeGreaterThan(1.5)
    // The film plays again (following the playhead) and is heard from.
    film.stuck = false
    await wait(1_500)
    // b3: the film's clock again.
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b3" })
    expect(getQueueProgress().filmClock).toBe(true)
  })

  // Film bundle merge (Nov 9): the panel runs its stall watchdog (and its
  // ladder: nudge, recover, rebuild, "Click to start") only where `filmClock`
  // says the film is the clock, and stops following the playhead there. Heard
  // from again in the middle of a line the queue was crossing on its own
  // timer, the film is that line's clock again at once, so the two never
  // disagree: never the queue's timer running the playhead while the panel
  // treats the film as the clock (and, the film stalling again, a 3 s wait
  // and the timer again, before the ladder's second rung).
  it("heard from again mid-line, the film is that line's clock at once: the playhead never runs on a timer while the panel treats the film as the clock", async () => {
    // Three stand-ins of 1.5 s: [0, 1.5), [1.5, 3), [3, 4.5). A 20 s film.
    const cells = [line("b1"), line("b2"), line("b3")]
    linkFilm(20, cells)
    film.stuck = true
    startQueue(ctxFor(cells), 0)
    await wait(3_250)
    // Given up on at 3 s: b1's rest on the queue's timer.
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b1" })
    expect(getQueueProgress().filmQuiet).toBe(true)
    expect(getQueueProgress().filmClock).toBe(false)
    // The film plays again, following the playhead, and is heard moving.
    film.stuck = false
    await wait(750)
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b1" })
    expect(getQueueProgress().filmQuiet).toBe(false)
    expect(getQueueProgress().filmClock).toBe(true)
    // It stalls again, still in b1 (about 1.0 s of its 1.5): the playhead
    // waits for it there, as the film is the clock. It does not run on into b2.
    film.stuck = true
    const at = getQueueProgress().currentTime
    expect(at).toBeLessThan(1.3)
    await wait(1_500)
    expect(getQueueState()).toMatchObject({ kind: "loading", cellId: "b1" })
    expect(getQueueProgress().currentTime).toBeCloseTo(at, 1)
    // 3 s after it was last heard, given up again: the rest of b1 on the
    // queue's timer, the film following, and the panel told so.
    await wait(1_600)
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b1" })
    expect(getQueueProgress().filmClock).toBe(false)
    expect(getQueueProgress().currentTime).toBeGreaterThan(at)
  })

  it("never skips the line: the playhead crosses every line in step, never jumping", async () => {
    const cells = [line("b1"), line("b2"), line("b3")]
    unknownFilm(cells)
    film.stuck = true
    startQueue(ctxFor(cells), 0)
    let last = 0
    const seen = new Set<string>()
    for (let i = 0; i < 40; i++) {
      await wait(250)
      const now = getQueueProgress().currentTime
      expect(now).toBeGreaterThanOrEqual(last - 0.001)
      expect(now - last).toBeLessThan(0.6)
      last = now
      const id = (getQueueState() as { cellId?: string }).cellId
      if (id) seen.add(id)
      if (getQueueState().kind === "idle") break
    }
    expect([...seen]).toEqual(["b1", "b2", "b3"])
    expect(getQueueState().kind).toBe("idle")
  })

  it("its length arriving is the film heard from again: the next line is the film's clock", async () => {
    const cells = [line("b1"), line("b2"), line("b3")]
    unknownFilm(cells)
    film.stuck = true
    startQueue(ctxFor(cells), 0)
    await wait(3_250)
    expect(getQueueProgress().filmClock).toBe(false)
    // Its length comes in; the film is still not playing (the panel had it
    // paused while it was not the clock), so it is not heard from otherwise.
    linkFilm(20, cells)
    await wait(1_500)
    expect(getQueueState()).toMatchObject({ cellId: "b2" })
    expect(getQueueProgress().filmClock).toBe(true)
  })

  it("a pause while the film is waited for is a pause: the patience does not run through it", async () => {
    const cells = [line("b1"), line("b2")]
    linkFilm(20, cells)
    film.stuck = true
    startQueue(ctxFor(cells), 0)
    await wait(2_000)
    pauseQueue()
    await wait(10_000)
    expect(getQueueState()).toMatchObject({ kind: "paused", cellId: "b1" })
    expect(getQueueProgress().currentTime).toBeCloseTo(0, 2)
    // Play again: a fresh wait for the film, then on.
    await resumeQueue()
    await wait(2_500)
    expect(getQueueState()).toMatchObject({ kind: "loading", cellId: "b1" })
  })

  it("over the film's tail nothing else plays, and the run still waits for the film", async () => {
    const cells = recorded()
    linkFilm(12, cells)
    film.stuck = true
    await playTheLinesOut(cells)
    await wait(10_000)
    expect(getQueueState()).toMatchObject({ kind: "loading", cellId: "b2" })
    expect(getQueueProgress().currentTime).toBeCloseTo(5, 1)
  })
})

// AQU-2253 (review 2, Nov 9), finding 5: under the film, a recorded line whose
// take would not load (a slow connection, offline, a take deleted since the
// list loaded) waited the readiness gate's 6 s with the film paused, then the
// playhead jumped to the next line and the film was cut forward by that
// line's length: the one jump left on a film file, though the film is behind
// the line. Now a line under the film that gives up on its take is crossed as
// a line with nothing of its own, on the film's clock, the film running on.
// (The 6 s wait itself is the gate's own rule, and stays: see the report.)
describe("a line under the film whose take gives up is crossed with the film, never jumped", () => {
  // b1 recorded 1 s [0, 1); b2 recorded 2 s [1, 3); b3 recorded 1 s [3, 4).
  const three = () => [line("b1", 1_000), line("b2", 2_000), line("b3", 1_000)]

  it("the reviewer's probe: b2's take never becomes ready: after the gate's wait b2 is crossed on the film's clock, then b3 plays", async () => {
    FakeAudio.cold.add("http://audio.test/b2.webm")
    const cells = three()
    linkFilm(10, cells)
    startQueue(ctxFor(cells), 0)
    await wait()
    el("b1")!.tick(1)
    await wait()
    expect(getQueueState()).toMatchObject({ kind: "loading", cellId: "b2" })
    await wait(5_900)
    expect(getQueueState()).toMatchObject({ kind: "loading", cellId: "b2" })
    expect(getQueueProgress().currentTime).toBeCloseTo(1, 2)
    await wait(200)
    // Not on to b3 at 3 s: b2 is crossed, from where it waited, with the film.
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b2" })
    expect(getQueueProgress().filmClock).toBe(true)
    expect(getQueueProgress().currentTime).toBeLessThan(1.3)
    await wait(1_000)
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b2" })
    expect(getQueueProgress().currentTime).toBeCloseTo(2, 0)
    await wait(1_100)
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b3" })
    expect(el("b3")!.paused).toBe(false)
  })

  it("a take that fails to load: crossed with the film at once", async () => {
    FakeAudio.failing.add("http://audio.test/b2.webm")
    const cells = three()
    linkFilm(10, cells)
    startQueue(ctxFor(cells), 0)
    await wait()
    el("b1")!.tick(1)
    await wait(500)
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b2" })
    expect(getQueueProgress().filmClock).toBe(true)
    expect(getQueueProgress().currentTime).toBeCloseTo(1.5, 1)
  })

  it("a take dying in the middle of its line: the rest of the line is crossed with the film", async () => {
    const cells = three()
    linkFilm(10, cells)
    startQueue(ctxFor(cells), 0)
    await wait()
    el("b1")!.tick(1)
    await wait()
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b2" })
    el("b2")!.tick(0.5)
    el("b2")!.fail()
    await wait(500)
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b2" })
    expect(getQueueProgress().filmClock).toBe(true)
    expect(getQueueProgress().currentTime).toBeCloseTo(2, 1)
    await wait(1_100)
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b3" })
  })

  it("the film's length not known yet: the same", async () => {
    FakeAudio.failing.add("http://audio.test/b2.webm")
    const cells = three()
    setProgrammeFilm({ endSec: null, cellIds: new Set(cells.map((c) => c.id)) })
    startQueue(ctxFor(cells), 0)
    await wait()
    el("b1")!.tick(1)
    await wait(500)
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b2" })
    expect(getQueueProgress().filmClock).toBe(true)
  })

  it("a take on another track sounding in the line keeps the queue's own clock there", async () => {
    setQueueTargetSlots(["recording", TRACK])
    setQueueLayerTrackSlots([TRACK])
    FakeAudio.failing.add("http://audio.test/b2.webm")
    // b2's own take fails; its 2 s Track 1 take plays from the line's start.
    const cells = [line("b1", 1_000), line("b2", 2_000, 2_000), line("b3", 1_000)]
    linkFilm(10, cells)
    startQueue(ctxFor(cells), 0)
    await wait()
    el("b1")!.tick(1)
    await wait(500)
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b2" })
    expect(getQueueProgress().filmClock).toBe(false)
    expect(el("b2-track")!.paused).toBe(false)
  })

  it("with no film, a take that never loads is still stepped past after the wait, and one that fails at once (as before)", async () => {
    FakeAudio.cold.add("http://audio.test/b2.webm")
    startQueue(ctxFor(three()), 0)
    await wait()
    el("b1")!.tick(1)
    await wait(6_100)
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b3" })
    stopQueue()

    FakeAudio.cold.clear()
    FakeAudio.failing.add("http://audio.test/b2.webm")
    startQueue(ctxFor(three()), 0)
    await wait()
    el("b1")!.tick(1)
    await wait(50)
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b3" })
  })

  it("a film that says nothing either: the gave-up line is crossed on the queue's own timer after the patience", async () => {
    FakeAudio.failing.add("http://audio.test/b2.webm")
    const cells = three()
    linkFilm(10, cells)
    startQueue(ctxFor(cells), 0)
    await wait()
    el("b1")!.tick(1)
    film.stuck = true
    await wait(3_300)
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b2" })
    expect(getQueueProgress().filmClock).toBe(false)
    await wait(2_000)
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b3" })
  })
})

// Sam, Nov 12 (question 44): one rule for a file with a linked film: a line
// nobody has recorded has something to play, the film, so "Play selected" and
// Next and Previous treat it as a line, as Play and Play all already do. The
// browser pass on the joined copy saw "Play selected" count and play lines 1
// and 3 of three, skipping line 2 under the film. "Play selected" there is a
// run of chosen lines over the file's list (`only`): on the file's clock, so
// the film follows it, shown and heard, as under a recorded line; it steps
// over the lines not chosen and stops at the end of the last chosen one.
describe("an unrecorded line under the film is a line: Play selected, and the question asked line by line", () => {
  // b1 recorded 2 s [0, 2); b2 a stand-in [2, 3.5); b3 recorded 1 s [3.5, 4.5).
  const chosen = () => [line("b1", 2_000), line("b2"), line("b3", 1_000)]
  const only = (...ids: string[]) => ({ only: new Set(ids) })
  /** What the film panel does with the queue's word (video-sync.ts): it
   *  follows the run when its clock is the file's, and is held still when not. */
  const panel = () => {
    const p = getQueueProgress()
    return videoSyncAction({
      kind: getQueueState().kind, clockIsFileTime: p.programmeClock, tickSec: p.currentTime, videoSec: 0,
      prevTickSec: null, prevTickAt: null, now: 0, rate: 1, duration: 600, lastSeekAt: null, filmIsClock: p.filmClock,
    }).kind
  }

  it("Play selected plays the unrecorded line with the film following the run, then the next one", async () => {
    const cells = chosen()
    linkFilm(10, cells)
    startQueue(ctxFor(cells, only("b1", "b2", "b3")), 0, true)
    await wait()
    expect(panel()).not.toBe("pause")
    el("b1")!.tick(2)
    await wait()
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b2" })
    // The file's clock: the film follows it (not held still), on the queue's
    // own timer, the film never the run's clock.
    expect(getQueueProgress()).toMatchObject({ programmeClock: true, filmClock: false })
    expect(panel()).not.toBe("pause")
    await wait(1_000)
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b2" })
    expect(getQueueProgress().currentTime).toBeCloseTo(3, 1)
    expect(film.sec).toBeCloseTo(3, 0)
    await wait(750)
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b3" })
    expect(el("b3")!.paused).toBe(false)
  })

  it("between chosen lines that are not next to each other the run, and the film with it, jump", async () => {
    // b1 [0, 2); b2 recorded 3 s [2, 5), not chosen; b3 a stand-in [5, 6.5).
    const cells = [line("b1", 2_000), line("b2", 3_000), line("b3")]
    linkFilm(20, cells)
    startQueue(ctxFor(cells, only("b1", "b3")), 0, true)
    await wait()
    el("b1")!.tick(2)
    await wait()
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b3" })
    expect(getQueueProgress().currentTime).toBeCloseTo(5, 1)
    expect(el("b2")).toBeUndefined()
    await wait(500)
    expect(film.sec).toBeCloseTo(5.5, 0)
  })

  it("stops at the end of the last chosen line: no run on to the film's end, and the panel lets go", async () => {
    const cells = [line("b1", 2_000), line("b2"), line("b3", 1_000)]
    linkFilm(20, cells)
    startQueue(ctxFor(cells, only("b1", "b2")), 0, true)
    await wait()
    el("b1")!.tick(2)
    await wait()
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b2" })
    await wait(1_600)
    expect(getQueueState().kind).toBe("idle")
    expect(el("b3")).toBeUndefined()
    expect(panel()).toBe("pause")
  })

  it("Next inside Play selected steps onto the unrecorded line, and never onto one not chosen", async () => {
    const cells = [...chosen(), line("b4", 1_000)]
    linkFilm(10, cells)
    startQueue(ctxFor(cells, only("b1", "b2", "b4")), 0, true)
    await wait()
    skipForward()
    await wait()
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b2" })
    skipForward()
    await wait()
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b4" })
  })

  it("a run of lines on their own (no film follows it) still crosses the unrecorded line, on the queue's own timer", async () => {
    const cells = chosen()
    linkFilm(10, cells)
    startQueue(ctxFor(cells, { snapshot: true }), 0, true)
    await wait()
    el("b1")!.tick(2)
    await wait()
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b2" })
    expect(film.reports).toBe(0)
    await wait(1_750)
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b3" })
  })

  it("asked of one line (what Play selected counts, and Next and Previous ask line by line), the film counts", () => {
    const [b1, b2] = chosen()
    linkFilm(10, chosen())
    expect(hasPlayableAudio(b2)).toBe(true)
    expect(hasAnyPlayableAudio([b2])).toBe(true)
    expect(hasPlayableAudio(b1)).toBe(true)
    // Play all's own move into the next chapter still asks without the film.
    expect(linesHaveAnythingOfTheirOwnToPlay([b2])).toBe(false)
  })

  describe("on a file with no film nothing changes: an unrecorded line has nothing to play", () => {
    it("Play selected skips it", async () => {
      const cells = chosen()
      startQueue(ctxFor(cells, { snapshot: true }), 0, true)
      await wait()
      el("b1")!.tick(2)
      await wait()
      expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b3" })
    })

    it("asked of one line, it has nothing", () => {
      const [b1, b2] = chosen()
      expect(hasPlayableAudio(b2)).toBe(false)
      expect(hasAnyPlayableAudio([b2])).toBe(false)
      expect(hasPlayableAudio(b1)).toBe(true)
    })
  })
})
