// AQU-2495 (review, Nov 9): following the recordings, after any run of Play
// has ended, Next on the play strip started line 1 on the wrong player — the
// plain line-by-line one, whose clock restarts at 0 per take — so the
// timeline's playhead stayed still, a film that follows the playhead stayed
// stopped, and playback then walked the lines one by one that way.
//
// Next from there now starts the first line the way Play does: laid out end
// to end, on the timeline's own clock.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  getQueueProgress,
  getQueueState,
  setQueueLayerTrackSlots,
  setQueueTargetSlots,
  setQueueTimingMode,
  skipBack,
  skipForward,
  startQueue,
  stopQueue,
  type PlayContext,
} from "./play-queue"
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
  error = null
  preload = ""
  src: string
  onended: (() => void) | null = null
  onerror: (() => void) | null = null
  ontimeupdate: (() => void) | null = null
  onloadedmetadata: (() => void) | null = null
  oncanplay: (() => void) | null = null
  onplay: (() => void) | null = null
  onplaying: (() => void) | null = null
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
  /** A timeupdate tick at clip second `t` — playback, not a seek. */
  tick(t: number): void {
    this._t = t
    this.ontimeupdate?.()
  }
  private listeners = new Map<string, Set<() => void>>()
  addEventListener(type: string, fn: () => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type)!.add(fn)
    if (type === "canplay" || type === "seeked") queueMicrotask(fn)
  }
  removeEventListener(type: string, fn: () => void): void {
    this.listeners.get(type)?.delete(fn)
  }
}

const settle = async (): Promise<void> => {
  for (let r = 0; r < 3; r++) {
    for (let i = 0; i < 8; i++) await Promise.resolve()
    await new Promise((res) => setTimeout(res, 0))
  }
}

/** A line with a 2 s take; `at` gives it times (a subtitle file, the kind a film is linked to). */
function line(id: string, at?: number): CellData {
  const takeId = `audio-${id}-1700000000-take.webm`
  return {
    id, fileId: "f1", original: `${id} words`, translated: "", medium: "text",
    ...(at != null ? { startTime: at, endTime: at + 4 } : {}),
    selectedAudioId: takeId,
    attachments: { [takeId]: { type: "audio", url: `http://audio.test/${id}.webm`, slot: "recording", durationMs: 2000 } },
  } as unknown as CellData
}

const ctxFor = (cells: CellData[]): PlayContext => ({
  cells,
  projectId: "p1",
  session: { jwt: "t", username: "dev", createdAt: "" } as PlayContext["session"],
})
const el = (id: string): FakeAudio | undefined =>
  [...FakeAudio.instances].reverse().find((a) => a.src === `http://audio.test/${id}.webm`)

/** Play all, to the end of the last line. */
async function playToTheEnd(cells: CellData[]): Promise<void> {
  startQueue(ctxFor(cells), 0)
  await settle()
  for (const cell of cells) {
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: cell.id })
    el(cell.id)!.tick(2)
    await settle()
  }
  expect(getQueueState().kind).toBe("idle")
}

beforeEach(() => {
  FakeAudio.instances = []
  vi.stubGlobal("Audio", FakeAudio)
  setQueueTargetSlots(["recording"])
  setQueueLayerTrackSlots([])
  setQueueTimingMode("audioFirst")
})

afterEach(() => {
  stopQueue()
  setQueueTimingMode("dubbing")
  vi.unstubAllGlobals()
})

describe.each([
  ["a book (no times)", () => [line("b1"), line("b2")]],
  ["a timed file (the kind a film is linked to)", () => [line("b1", 0), line("b2", 4)]],
])("following the recordings, Next after a run has ended — %s (AQU-2495)", (_name, make) => {
  it("starts the first line on the timeline's clock, so the playhead (and a film following it) moves", async () => {
    const cells = make()
    await playToTheEnd(cells)

    skipForward()
    await settle()
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b1" })
    // The clock is the laid-out timeline's, not the take's own.
    expect(getQueueProgress().programmeClock).toBe(true)

    // …and it carries on as Play all does: on to the next line at the first's end.
    el("b1")!.tick(2)
    await settle()
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b2" })
    expect(getQueueProgress().programmeClock).toBe(true)
    expect(getQueueProgress().currentTime).toBeCloseTo(2, 1)
  })

  it("Previous after a run has ended still does nothing", async () => {
    await playToTheEnd(make())
    skipBack()
    await settle()
    expect(getQueueState().kind).toBe("idle")
  })

  it("Next while playing still goes to the next line, and past the last line stops", async () => {
    startQueue(ctxFor(make()), 0)
    await settle()
    skipForward()
    await settle()
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b2" })
    expect(getQueueProgress().programmeClock).toBe(true)
    skipForward()
    await settle()
    expect(getQueueState().kind).toBe("idle")
  })
})

describe("following the source, Next after a run has ended (unchanged)", () => {
  it("starts the first line, line by line", async () => {
    setQueueTimingMode("dubbing")
    const cells = [line("b1"), line("b2")]
    startQueue(ctxFor(cells), 0)
    await settle()
    el("b1")!.onended?.()
    await settle()
    el("b2")!.onended?.()
    await settle()
    expect(getQueueState().kind).toBe("idle")
    skipForward()
    await settle()
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b1" })
    expect(getQueueProgress().programmeClock).toBe(false)
  })
})
