// AQU-1758 (Sam, Oct 29): picking a chapter in the picker while Play all is
// playing jumps to that chapter and keeps playing, from its first line, in
// both timings. Picking one while playback is paused still ends that playback,
// and picking the chapter that is playing changes nothing.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { applyChapterPick, planChapterPick, rowEndsPlayback } from "./chapter-pick"
import type { TimelineChapter } from "./sequence-timeline"
import {
  getQueueProgress, getQueueState, queuePlaybackAsk, setProgrammeFilm, setQueueTimingMode, startQueue, stopQueue, type PlayContext,
} from "@/lib/audio/play-queue"
import type { CellData } from "@/hooks/useCells"

class FakeAudio {
  static instances: FakeAudio[] = []
  currentTime = 0
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
  addEventListener(type: string, fn: () => void): void {
    if (type === "canplay" || type === "seeked") queueMicrotask(() => fn())
  }
  removeEventListener(): void {}
}

/** A verse of a book, recorded: a take of 2 s. */
function verse(id: string): CellData {
  const takeId = `audio-${id}-1700000000-take.webm`
  return {
    id, fileId: "f1", original: `${id} words`, translated: "", medium: "text",
    selectedAudioId: takeId,
    attachments: { [takeId]: { type: "audio", url: `http://audio.test/${id}.webm`, durationMs: 2000 } },
  } as unknown as CellData
}

const RUTH = [verse("r1v1"), verse("r1v2"), verse("r2v1"), verse("r2v2")]
const CHAPTERS: TimelineChapter[] = [
  { key: "RUT 1", cellIds: ["r1v1", "r1v2"] },
  { key: "RUT 2", cellIds: ["r2v1", "r2v2"] },
]
const session = { jwt: "t", username: "dev", createdAt: "" } as PlayContext["session"]
const take = (id: string) => [...FakeAudio.instances].reverse().find((a) => a.src.includes(`/${id}.webm`))
const settle = () => vi.advanceTimersByTimeAsync(0)

/** What the queue's own answer turns on, following the recordings with no
 *  film and "Skip lines with nothing to play" on (the defaults). */
const ASK = { freeTiming: true, film: null, skipSilent: true } as const

describe("planChapterPick", () => {
  const plan = (pickedKey: string, playingKey: string | null, queueKind: ReturnType<typeof getQueueState>["kind"]) =>
    planChapterPick({ chapters: CHAPTERS, lines: RUTH, pickedKey, playingKey, queueKind, ask: ASK })

  it("while playing another chapter: play the picked one", () => {
    expect(plan("RUT 2", "RUT 1", "playing")).toEqual({ kind: "play", chapter: CHAPTERS[1] })
    expect(plan("RUT 2", "RUT 1", "loading")).toEqual({ kind: "play", chapter: CHAPTERS[1] })
  })

  it("while paused on another chapter: stop, as before", () => {
    expect(plan("RUT 2", "RUT 1", "paused")).toEqual({ kind: "stop" })
  })

  it("the chapter that is playing, or nothing playing on this file: only show it", () => {
    expect(plan("RUT 1", "RUT 1", "playing")).toEqual({ kind: "show" })
    expect(plan("RUT 2", null, "idle")).toEqual({ kind: "show" })
  })

  it("a picked chapter with nothing to play: stop", () => {
    const silent = [...RUTH.slice(0, 2), { ...verse("r2v1"), selectedAudioId: undefined, attachments: {} } as unknown as CellData]
    expect(
      planChapterPick({ chapters: CHAPTERS, lines: silent, pickedKey: "RUT 2", playingKey: "RUT 1", queueKind: "playing", ask: ASK }),
    ).toEqual({ kind: "stop" })
  })

  // The check of the q44 fixes (Nov 12), aquilla-media's pick: a pick asks
  // what pressing Play on the chapter asks, the queue's own answer for its
  // lines (`linesPlaybackStopsAt`), with the same Skip setting.
  it("with Skip off, a picked chapter nobody has recorded is played through, in silence, as Play would", () => {
    const silent = [...RUTH.slice(0, 2), { ...verse("r2v1"), selectedAudioId: undefined, attachments: {} } as unknown as CellData]
    expect(
      planChapterPick({ chapters: CHAPTERS, lines: silent, pickedKey: "RUT 2", playingKey: "RUT 1", queueKind: "playing", ask: { ...ASK, skipSilent: false } }),
    ).toEqual({ kind: "play", chapter: CHAPTERS[1] })
  })

  it("a picked chapter whose lines all lie past its film's end has nothing to play: stop", () => {
    const unrecorded = (id: string) => ({ ...verse(id), selectedAudioId: undefined, attachments: {} }) as unknown as CellData
    const book = [...RUTH.slice(0, 2), unrecorded("r2v1"), unrecorded("r2v2")]
    // The film behind every chapter is 0.01 s long: each chapter runs from 0:00.
    const film = { endSec: 0.01, runsOn: false, cellIds: new Set(book.map((c) => c.id)) }
    expect(
      planChapterPick({ chapters: CHAPTERS, lines: book, pickedKey: "RUT 2", playingKey: "RUT 1", queueKind: "playing", ask: { ...ASK, film } }),
    ).toEqual({ kind: "stop" })
    expect(
      planChapterPick({ chapters: CHAPTERS, lines: book, pickedKey: "RUT 2", playingKey: "RUT 1", queueKind: "playing", ask: { ...ASK, film: { ...film, endSec: 60 } } }),
    ).toEqual({ kind: "play", chapter: CHAPTERS[1] })
  })
})

describe.each([
  ["following the source", "dubbing"],
  ["following the recordings", "audioFirst"],
] as const)("picking Ruth 2 during Play all of Ruth 1, %s", (_label, mode) => {
  beforeEach(() => {
    FakeAudio.instances = []
    vi.stubGlobal("Audio", FakeAudio)
    vi.useFakeTimers()
    setQueueTimingMode(mode)
  })
  afterEach(() => {
    stopQueue()
    setQueueTimingMode("dubbing")
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it("jumps to Ruth 2's first line and keeps playing", async () => {
    startQueue({ cells: RUTH.slice(0, 2), projectId: "p1", session }, 0)
    await settle()
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "r1v1" })

    const plan = planChapterPick({ chapters: CHAPTERS, lines: RUTH, pickedKey: "RUT 2", playingKey: "RUT 1", queueKind: getQueueState().kind, ask: queuePlaybackAsk() })
    applyChapterPick(plan, { lines: RUTH, projectId: "p1", session })
    await settle()
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "r2v1", cellIndex: 2 })
    expect(take("r2v1")?.paused).toBe(false)
    // Nothing of Ruth 1 sounds any more.
    expect(FakeAudio.instances.filter((a) => a.src.includes("/r1v") && !a.paused)).toHaveLength(0)
  })
})

// AQU-1758: scrolling the table onto another chapter is not a pick. Play all
// paused at Ruth 1:2 and the table scrolled on to read Ruth 2 still resumes at
// Ruth 1:2; only a pick, or a row of another chapter clicked, ends it.
describe("a row of another chapter, while playback is paused (AQU-1758)", () => {
  beforeEach(() => {
    FakeAudio.instances = []
    vi.stubGlobal("Audio", FakeAudio)
    vi.useFakeTimers()
  })
  afterEach(() => {
    stopQueue()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it("ends a paused playback only for a row of another chapter", () => {
    expect(rowEndsPlayback({ rowKey: "RUT 2", playingKey: "RUT 1", queueKind: "paused" })).toBe(true)
    expect(rowEndsPlayback({ rowKey: "RUT 1", playingKey: "RUT 1", queueKind: "paused" })).toBe(false)
    expect(rowEndsPlayback({ rowKey: "RUT 2", playingKey: "RUT 1", queueKind: "playing" })).toBe(false)
    expect(rowEndsPlayback({ rowKey: "RUT 2", playingKey: null, queueKind: "idle" })).toBe(false)
  })

  it("is the queue's real state that decides: paused at Ruth 1:2, a row of Ruth 2 ends it", async () => {
    startQueue({ cells: RUTH.slice(0, 2), projectId: "p1", session }, 1)
    await settle()
    take("r1v2")?.pause()
    await settle()
    expect(getQueueState()).toMatchObject({ kind: "paused", cellId: "r1v2" })
    expect(rowEndsPlayback({ rowKey: "RUT 2", playingKey: "RUT 1", queueKind: getQueueState().kind })).toBe(true)
  })
})

// AQU-2253 (review 2, Nov 9), finding 4: on a book with a linked film, a chapter
// nobody has recorded plays with the film when someone asks for it (the
// strip's Play, Space). Picking it in the chapter picker while Play all plays
// is asking for it too, so it plays, the same answer; only Play all's own move
// into the next chapter asks for something of the chapter's own.
describe("picking a chapter nobody has recorded, on a book with a linked film", () => {
  const unrecorded = (id: string) => ({ ...verse(id), selectedAudioId: undefined, attachments: {} }) as unknown as CellData
  /** Ruth 1 recorded, Ruth 2 not. */
  const book = [verse("r1v1"), verse("r1v2"), unrecorded("r2v1"), unrecorded("r2v2")]
  /** The workspace's word on a book: the film named with every chapter's lines. */
  const bookFilm = () => setProgrammeFilm({ endSec: 600, runsOn: false, cellIds: new Set(book.map((c) => c.id)) })
  const pickRuth2 = () =>
    planChapterPick({ chapters: CHAPTERS, lines: book, pickedKey: "RUT 2", playingKey: "RUT 1", queueKind: "playing", ask: queuePlaybackAsk() })

  beforeEach(() => {
    FakeAudio.instances = []
    vi.stubGlobal("Audio", FakeAudio)
    vi.useFakeTimers()
    setQueueTimingMode("audioFirst")
  })
  afterEach(() => {
    stopQueue()
    setProgrammeFilm(null)
    setQueueTimingMode("dubbing")
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it("with the film behind its lines: play it", () => {
    bookFilm()
    expect(pickRuth2()).toEqual({ kind: "play", chapter: CHAPTERS[1] })
  })

  it("with no film: stop, as before", () => {
    expect(pickRuth2()).toEqual({ kind: "stop" })
  })

  it("during Play all of Ruth 1, the pick plays Ruth 2 with the film", async () => {
    bookFilm()
    startQueue({ cells: book.slice(0, 2), projectId: "p1", session }, 0)
    await settle()
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "r1v1" })
    applyChapterPick(
      planChapterPick({ chapters: CHAPTERS, lines: book, pickedKey: "RUT 2", playingKey: "RUT 1", queueKind: getQueueState().kind, ask: queuePlaybackAsk() }),
      { lines: book, projectId: "p1", session },
    )
    await settle()
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "r2v1" })
    expect(getQueueProgress().filmClock).toBe(true)
  })
})
