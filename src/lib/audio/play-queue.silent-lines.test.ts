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
  onQueueRanOut,
  pauseQueue,
  resumeQueue,
  seekQueueToTime,
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
