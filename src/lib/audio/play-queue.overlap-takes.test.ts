// AQU-2432 (Sam, Nov 6, rule 2): following the recordings a take can be
// dragged earlier, over the end of the take before it, and the overlap PLAYS
// BOTH TAKES, mixed at full volume, with no ducking and no cutting off. The
// transport clocks each line by its own take on the main track; the next
// line's take on the same track must not stop the earlier one, which plays on
// to its own end.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  getDubDebugSnapshot,
  getQueueState,
  pauseQueue,
  resumeQueue,
  setQueueAudibility,
  setQueueLayerTrackSlots,
  setQueueTargetSlots,
  setQueueTimingMode,
  startQueue,
  startQueueAtTime,
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
  addEventListener(type: string, fn: () => void): void {
    if (type === "canplay" || type === "seeked") queueMicrotask(fn)
  }
  removeEventListener(): void {}
}

const settle = async (): Promise<void> => {
  for (let r = 0; r < 3; r++) {
    for (let i = 0; i < 8; i++) await Promise.resolve()
    await new Promise((res) => setTimeout(res, 0))
  }
}

/** A line of a book with no times and a take on the main track, placed
 *  `recordingsOffsetMs` from where its line would start. */
function line(id: string, mainMs: number, recordingsOffsetMs?: number): CellData {
  const mainId = `audio-${id}-1700000000-main.webm`
  return {
    id, fileId: "f1", original: `${id} words`, translated: "", medium: "text",
    selectedAudioId: mainId,
    attachments: {
      [mainId]: {
        type: "audio", url: `http://audio.test/${id}.webm`, slot: "recording", durationMs: mainMs,
        ...(recordingsOffsetMs != null ? { recordingsOffsetMs } : {}),
      },
    },
  } as unknown as CellData
}

/** Mia's b1 (a 3 s take); Lee's b2 (2 s) pulled 1 s back over its end, so b1
 *  lasts 0–2 s and b2 2–4 s; b3 (2 s) 4–6 s. */
const scene = () => [line("b1", 3000), line("b2", 2000, -1000), line("b3", 2000)]

const ctxFor = (cells: CellData[]): PlayContext => ({
  cells,
  projectId: "p1",
  session: { jwt: "t", username: "dev", createdAt: "" } as PlayContext["session"],
})

/** The newest player for a take. */
const el = (name: string): FakeAudio | undefined =>
  [...FakeAudio.instances].reverse().find((a) => a.src === `http://audio.test/${name}.webm`)
const sounding = () => getDubDebugSnapshot().pool.map((e) => e.cellId).sort()

beforeEach(() => {
  FakeAudio.instances = []
  vi.stubGlobal("Audio", FakeAudio)
  setQueueTargetSlots(["recording"])
  setQueueLayerTrackSlots([])
  setQueueAudibility({ source: true, target: true })
  setQueueTimingMode("audioFirst")
})

afterEach(() => {
  stopQueue()
  setQueueTimingMode("dubbing")
  vi.unstubAllGlobals()
})

describe("a take pulled back over the take before it plays over it (AQU-2432)", () => {
  it("when the next line starts, its take comes in and the take before it plays on — the same player, not stopped", async () => {
    startQueue(ctxFor(scene()), 0)
    await settle()
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b1" })
    const mia = el("b1")!
    mia.tick(2) // b1's line ends at 2 s; its take has a second left
    await settle()
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b2" })
    expect(el("b2")!.paused).toBe(false)
    expect(el("b1")).toBe(mia)
    expect(mia.paused).toBe(false)
    expect(sounding()).toEqual(["b1", "b2"])
  })

  it("the earlier take stops at its own end, and the later one plays on", async () => {
    startQueue(ctxFor(scene()), 0)
    await settle()
    const mia = el("b1")!
    mia.tick(2)
    await settle()
    el("b2")!.tick(0.5)
    mia.tick(3)
    await settle()
    expect(sounding()).toEqual(["b2"])
    expect(el("b2")!.paused).toBe(false)
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b2" })
  })

  it("the later take clocks its line: at its end the next line follows", async () => {
    startQueue(ctxFor(scene()), 0)
    await settle()
    el("b1")!.tick(2)
    await settle()
    el("b2")!.tick(2)
    await settle()
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b3" })
  })

  it("a seek into the overlap plays both from there", async () => {
    startQueueAtTime(ctxFor(scene()), 2.5)
    await settle()
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b2" })
    expect(el("b2")!.paused).toBe(false)
    expect(el("b1")!.paused).toBe(false)
    // Mia's take 2.5 s in, Lee's half a second.
    expect(el("b1")!.currentTime).toBeCloseTo(2.5, 2)
    expect(sounding()).toEqual(["b1", "b2"])
  })

  it("pauses and resumes both", async () => {
    startQueue(ctxFor(scene()), 0)
    await settle()
    const mia = el("b1")!
    mia.tick(2)
    await settle()
    pauseQueue()
    expect(mia.paused).toBe(true)
    expect(el("b2")!.paused).toBe(true)
    await resumeQueue()
    await settle()
    expect(mia.paused).toBe(false)
    expect(el("b2")!.paused).toBe(false)
  })

  it("a take pulled back to the very start of the take before it: both start together", async () => {
    const cells = [line("b1", 3000), line("b2", 2000, -9000), line("b3", 2000)]
    startQueue(ctxFor(cells), 0)
    await settle()
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b2" })
    expect(el("b1")!.paused).toBe(false)
    expect(el("b2")!.paused).toBe(false)
    expect(el("b1")!.currentTime).toBeCloseTo(0, 2)
  })

  it("a take whose line was pulled to its start after a pause: the pause is waited out, then both", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "performance"] })
    try {
      // b1's take starts 1 s into its line; b2 pulled back to that start.
      const cells = [line("b1", 3000, 1000), line("b2", 2000, -9000)]
      startQueue(ctxFor(cells), 0)
      await vi.advanceTimersByTimeAsync(10)
      expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b1" })
      expect(el("b1")?.paused ?? true).toBe(true)
      await vi.advanceTimersByTimeAsync(1100)
      expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b2" })
      expect(el("b1")!.paused).toBe(false)
      expect(el("b2")!.paused).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})
