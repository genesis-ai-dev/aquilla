// Sam's decision (hidden lines on the timeline): a hidden line's takes never
// sound — under the built-in clock or a film, in Free timing, in Play all from
// the bottom bar — while an imported recording under it plays on.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("./upload", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  probeCellAudioPresent: async () => "unknown",
  getCellAudioStreamUrl: async () => null,
}))
vi.mock("./bytes-cache", () => ({
  audioCacheGet: async () => null,
  audioCachePut: async () => undefined,
}))

import {
  hasAnyPlayableAudio,
  planUpcomingDubs,
  setExternalDubsPlaying,
  setQueueAudibility,
  setQueueTimingMode,
  startExternalDubs,
  startQueue,
  stopExternalDubs,
  stopQueue,
  tickExternalDubs,
  type PlayContext,
} from "./play-queue"
import type { CellData } from "@/hooks/useCells"

class FakeAudio {
  static instances: FakeAudio[] = []
  src: string
  paused = true
  ended = false
  muted = false
  volume = 1
  playbackRate = 1
  currentTime = 0
  duration = 600
  readyState = 4
  preload = ""
  error = null
  onended: null | (() => void) = null
  onerror: null | (() => void) = null
  ontimeupdate: null | (() => void) = null
  onloadedmetadata: null | (() => void) = null
  ondurationchange: null | (() => void) = null
  onpause: null | (() => void) = null
  onplay: null | (() => void) = null
  onplaying: null | (() => void) = null
  oncanplay: null | (() => void) = null
  constructor(src = "") {
    this.src = src
    FakeAudio.instances.push(this)
  }
  play(): Promise<void> {
    this.paused = false
    this.onplay?.()
    return Promise.resolve()
  }
  pause(): void {
    this.paused = true
    this.onpause?.()
  }
  addEventListener(type: string, fn: () => void): void {
    if (type === "canplay" || type === "seeked") queueMicrotask(fn)
  }
  removeEventListener(): void {}
  tick(t: number): void {
    this.currentTime = t
    this.ontimeupdate?.()
  }
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0))
}
const ctxFor = (cells: CellData[]): PlayContext => ({
  cells, projectId: "p1", session: { jwt: "t", username: "dev", createdAt: "" } as PlayContext["session"],
})
const players = (name: string) => FakeAudio.instances.filter((a) => a.src.includes(name))
const hidden = (cell: CellData): CellData => ({ ...cell, hidden: true }) as CellData

const CLIP = "http://audio.test/clip.mp3"
const SOURCE_ID = "audio-f1-1690000000-shared.mp3"

/** A line with a 2s take; `source` gives it a section of an imported recording. */
function line(id: string, start: number, end: number, opts: { source?: boolean; medium?: string } = {}): CellData {
  const takeId = `audio-${id}-1700000000-take.wav`
  return {
    id, fileId: "f1", original: "", translated: "", medium: opts.medium ?? (opts.source ? "media" : "text"),
    startTime: start, endTime: end,
    selectedAudioId: takeId,
    attachments: {
      [takeId]: { type: "audio", url: `http://audio.test/take-${id}.wav`, durationMs: 2000 },
      ...(opts.source ? { [SOURCE_ID]: { type: "audio", url: CLIP } } : {}),
    },
  } as unknown as CellData
}

beforeEach(() => {
  FakeAudio.instances = []
  vi.stubGlobal("Audio", FakeAudio)
  setQueueAudibility({ source: true, target: true })
})
afterEach(() => {
  stopExternalDubs()
  stopQueue()
  setQueueTimingMode("dubbing")
  vi.unstubAllGlobals()
})

describe("under the built-in clock or a film", () => {
  it("never plays a hidden line's take, nor makes it ready", async () => {
    const cells = [hidden(line("a", 2, 6)), line("b", 7, 11)]
    expect(planUpcomingDubs(cells, 1, { masterIsExternal: true }).map((n) => n.cellId)).toEqual(["b"])
    startExternalDubs(ctxFor(cells))
    setExternalDubsPlaying(true)
    tickExternalDubs(1)
    tickExternalDubs(2.05)
    await settle()
    expect(players("take-a")).toHaveLength(0)
    tickExternalDubs(7.02)
    await settle()
    expect(players("take-b")[0]?.paused).toBe(false)
  })
})

describe("under an imported recording (Original's timing)", () => {
  it("plays the recording under a hidden line, but not the line's take", async () => {
    startQueue(ctxFor([hidden(line("s1", 0, 5, { source: true })), line("s2", 5, 10, { source: true })]), 0)
    await settle()
    const master = FakeAudio.instances.find((a) => a.src === CLIP)
    expect(master?.paused).toBe(false)
    expect(players("take-s1")).toHaveLength(0)
    master!.tick(5.01)
    await settle()
    expect(players("take-s2")[0]?.paused).toBe(false)
  })
})

describe("in Free timing", () => {
  it("plays a hidden verse's original but not its take", async () => {
    setQueueTimingMode("audioFirst")
    startQueue(ctxFor([hidden(line("v1", 0, 6, { source: true })), line("v2", 6, 16, { source: true })]), 0)
    await settle()
    expect(FakeAudio.instances.find((a) => a.src === CLIP)?.paused).toBe(false)
    expect(players("take-v1")).toHaveLength(0)
  })

  it("steps over a hidden verse that has nothing else to play", async () => {
    setQueueTimingMode("audioFirst")
    startQueue(ctxFor([hidden(line("v1", 0, 6, { medium: "media" })), line("v2", 6, 16, { medium: "media" })]), 0)
    await settle()
    expect(players("take-v1")).toHaveLength(0)
    expect(players("take-v2")[0]?.paused).toBe(false)
  })
})

describe("Play all from the bottom bar", () => {
  it("skips a hidden line", async () => {
    const a = hidden({ ...line("a", 0, 0), startTime: undefined, endTime: undefined } as unknown as CellData)
    const b = { ...line("b", 0, 0), startTime: undefined, endTime: undefined } as unknown as CellData
    startQueue(ctxFor([a, b]), 0)
    await settle()
    expect(players("take-a")).toHaveLength(0)
    expect(players("take-b")[0]?.paused).toBe(false)
  })

  it("has nothing to play when only hidden lines are voiced", () => {
    expect(hasAnyPlayableAudio([hidden(line("a", 0, 0))])).toBe(false)
  })
})
