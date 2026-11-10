// AQU-2494 (review, Nov 9), finding 9: on the timeline, a take with a volume
// change or fades that is not on this device streams, and a stream from the
// sync worker cannot go through the mixer (its sound is cross-origin). It
// played at the recorded volume with no fades, while the line's own play
// button played it at its level. It now streams WITH its level on the player,
// as far as a player's volume goes (it can turn a take down and step along
// its fades, not raise it above as recorded), in both timings.
//
// The mixer is the real one, on a stand-in context that is running; the
// cache is empty, so every take streams.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("./bytes-cache", () => ({
  audioCacheGet: async () => null,
  audioCachePut: async () => {},
}))
vi.mock("./upload", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getCellAudioStreamUrl: vi.fn(async (a: { audioId: string; ext: string }) => `https://sync.example/audio/${a.audioId}.${a.ext}?t=x`),
}))

import { __resetMixerForTests } from "./mixer"
import { resetOutputContextForTests } from "./output-context"
import { setQueueTimingMode, setQueueVolume, startQueue, stopQueue, type PlayContext } from "./play-queue"
import type { CellData } from "@/hooks/useCells"

class StubParam {
  value = 1
  setValueAtTime(v: number) { this.value = v }
  linearRampToValueAtTime() {}
  cancelScheduledValues() {}
}
class StubCtx {
  state = "running"
  currentTime = 0
  destination = {}
  routed: unknown[] = []
  resume() { return Promise.resolve() }
  createGain() { return { gain: new StubParam(), connect() {} } }
  createMediaElementSource(el: unknown) { this.routed.push(el); return { connect() {} } }
}

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
  error = null
  src: string
  get currentSrc() { return this.src }
  preload = ""
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
  async play(): Promise<void> { this.paused = false; this.onplay?.() }
  pause(): void { this.paused = true }
  addEventListener(type: string, fn: () => void): void {
    if (type === "canplay" || type === "seeked") queueMicrotask(fn)
  }
  removeEventListener(): void {}
}

const settle = async (): Promise<void> => {
  for (let r = 0; r < 4; r++) {
    for (let i = 0; i < 10; i++) await Promise.resolve()
    await new Promise((res) => setTimeout(res, 0))
  }
}

const TAKE = "audio-a-1700000000-take"
const dB = (db: number) => Math.pow(10, db / 20)

const line = (medium: string | undefined, level: Record<string, unknown>) =>
  ({
    id: "a", fileId: "f1", original: "", translated: "", startTime: 0, endTime: 5,
    ...(medium ? { medium } : {}),
    selectedAudioId: `${TAKE}.wav`,
    attachments: {
      [`${TAKE}.wav`]: { type: "audio", url: `frontier-audio://${TAKE}.wav`, slot: "recording", durationMs: 5000, ...level },
    },
  }) as unknown as CellData

const ctxFor = (cells: CellData[]): PlayContext => ({
  cells, projectId: "p1", session: { jwt: "t", username: "dev", createdAt: "" } as PlayContext["session"],
})

let ctx: StubCtx
beforeEach(() => {
  FakeAudio.instances = []
  ctx = new StubCtx()
  vi.stubGlobal("Audio", FakeAudio)
  vi.stubGlobal("AudioContext", function AC() { return ctx } as unknown as typeof AudioContext)
})
afterEach(() => {
  stopQueue()
  setQueueVolume(1)
  setQueueTimingMode("dubbing")
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  __resetMixerForTests()
  resetOutputContextForTests()
})

async function streamedTake(mode: "dubbing" | "audioFirst", cell: CellData): Promise<FakeAudio> {
  setQueueTimingMode(mode)
  startQueue(ctxFor([cell]), 0)
  await settle()
  const el = FakeAudio.instances.find((a) => a.src.startsWith("https://sync.example/"))!
  expect(el).toBeTruthy()
  expect(ctx.routed).not.toContain(el)
  return el
}

describe("a take with a level that is not on this device, on the timeline", () => {
  it("following the source (a text line's take): streams turned down to its volume", async () => {
    const el = await streamedTake("dubbing", line(undefined, { gainDb: -6 }))
    expect(el.volume).toBeCloseTo(dB(-6), 5)
  })

  it("following the recordings: streams turned down to its volume", async () => {
    const el = await streamedTake("audioFirst", line("media", { gainDb: -6 }))
    expect(el.volume).toBeCloseTo(dB(-6), 5)
  })

  it("its fade-in starts from silence on the player", async () => {
    const el = await streamedTake("dubbing", line(undefined, { fadeInMs: 300 }))
    el.currentTime = 0
    el.ontimeupdate?.()
    expect(el.volume).toBeLessThan(0.2)
  })

  it("the playback bar's volume keeps its level, not over it", async () => {
    const el = await streamedTake("dubbing", line(undefined, { gainDb: -6 }))
    setQueueVolume(0.5)
    expect(el.volume).toBeCloseTo(0.5 * dB(-6), 5)
  })

  it("a take as recorded streams at the main volume, as before", async () => {
    const el = await streamedTake("dubbing", line(undefined, {}))
    expect(el.volume).toBe(1)
  })
})
