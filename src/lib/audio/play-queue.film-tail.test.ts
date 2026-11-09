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
  onQueueRanOut,
  pauseQueue,
  resumeQueue,
  seekQueueToTime,
  setProgrammeFilm,
  setQueueLayerTrackSlots,
  setQueueRate,
  setQueueTargetSlots,
  setQueueTimingMode,
  skipBack,
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
 * `stuck` (buffering, or not started).
 */
const film = { sec: 0, stuck: false, reports: 0 }
let filmTimer: ReturnType<typeof setInterval> | null = null
function filmBeat(): void {
  const kind = getQueueState().kind
  const p = getQueueProgress()
  if ((kind !== "playing" && kind !== "loading") || !p.programmeClock) return
  if (!p.filmClock) {
    film.sec = p.currentTime
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

  it("once a line is recorded, lines with nothing to play are skipped as before, and the film's tail still plays", async () => {
    // b1 a stand-in [0, 1.5); b2 recorded 3 s [1.5, 4.5); b3 a stand-in [4.5, 6).
    const cells = [line("b1"), line("b2", 3_000), line("b3")]
    linkFilm(10, cells)
    startQueue(ctxFor(cells), 0)
    await wait()
    // Straight to the recorded line.
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b2" })
    expect(getQueueProgress().currentTime).toBeCloseTo(1.5, 2)
    el("b2")!.tick(3)
    await wait()
    // b3 is skipped: on to the film after the lines' end, at 6 s.
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b3" })
    expect(getQueueProgress().currentTime).toBeCloseTo(6, 2)
    await wait(4_050)
    expect(getQueueState().kind).toBe("idle")
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

  it("nothing recorded: the playhead does not leave the start until the film plays", async () => {
    const cells = unrecorded()
    linkFilm(10, cells)
    film.stuck = true
    startQueue(ctxFor(cells), 0)
    await wait(4_000)
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

  it("a take landing while the film carries the lines does not leave the run waiting on the film", async () => {
    const cells = unrecorded()
    linkFilm(10, cells)
    startQueue(ctxFor(cells), 0)
    await wait(500)
    expect(getQueueProgress().filmClock).toBe(true)
    // b3 is recorded now: the film no longer carries the lines.
    updateQueueCells([line("b1"), line("b2"), line("b3", 2_000)])
    await wait(1_100)
    // The rest of b1 was crossed; b2 has nothing and is skipped; b3 plays.
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b3" })
    expect(el("b3")!.paused).toBe(false)
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

  it("a silent line between recorded ones, under a film that follows the queue, takes the new speed at once", async () => {
    setSkipSilentLinesPref(false)
    // b1 recorded 2 s [0, 2); b2 a stand-in [2, 3.5); b3 recorded 1 s [3.5, 4.5).
    const cells = [line("b1", 2_000), line("b2"), line("b3", 1_000)]
    linkFilm(10, cells)
    startQueue(ctxFor(cells), 0)
    await wait()
    el("b1")!.tick(2)
    await wait(500)
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b2" })
    expect(getQueueProgress().filmClock).toBe(false)
    expect(getQueueProgress().currentTime).toBeCloseTo(2.5, 1)
    setQueueRate(2)
    await wait(300)
    expect(getQueueProgress().currentTime).toBeCloseTo(3.1, 1)
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
