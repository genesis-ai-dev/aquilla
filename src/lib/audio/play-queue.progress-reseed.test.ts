// 2026-08-08 (bounce forensics): a cross-clip mid-play jump used to reset the
// progress readout to 0 for the whole network resolve (disposeCurrent's
// reset), painting the playhead at x=0 until the new clip landed. The open
// path now re-seeds progress with the seek target synchronously.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { CellData } from "@/hooks/useCells"

const fetchCellAudio = vi.fn()
vi.mock("./upload", async () => {
  const actual = await vi.importActual<typeof import("./upload")>("./upload")
  return {
    ...actual,
    fetchCellAudio: (...args: unknown[]) => fetchCellAudio(...args),
    probeCellAudioPresent: async () => "unknown",
    getCellAudioStreamUrl: () => null,
  }
})
vi.mock("./bytes-cache", () => ({
  audioCacheGet: async () => null,
  audioCachePut: async () => undefined,
}))
vi.mock("./sync-token-fetcher", () => ({
  audioSyncTokenFetcherForSession: () => async () => "tok",
}))

import {
  getQueueProgress,
  getQueueState,
  seekQueueToTime,
  setQueueTimingMode,
  startQueue,
  stopQueue,
  type PlayContext,
} from "./play-queue"
import { buildFrontierAudioUrl } from "./upload"

const CLIP_A = "http://audio.test/clip-a.mp3"

class FakeAudio {
  static instances: FakeAudio[] = []
  src: string
  paused = true
  muted = false
  volume = 1
  playbackRate = 1
  currentTime = 0
  duration = NaN
  readyState = 4
  preload = ""
  onended: null | (() => void) = null
  onerror: null | (() => void) = null
  ontimeupdate: null | (() => void) = null
  onloadedmetadata: null | (() => void) = null
  ondurationchange: null | (() => void) = null
  onpause: null | (() => void) = null
  onplay: null | (() => void) = null
  private listeners = new Map<string, Set<() => void>>()
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
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type)!.add(fn)
    if ((type === "canplay" || type === "seeked") && this.readyState >= 3) {
      queueMicrotask(() => this.emit(type))
    }
  }
  removeEventListener(type: string, fn: () => void): void {
    this.listeners.get(type)?.delete(fn)
  }
  private emit(type: string): void {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn()
  }
  tick(t: number): void {
    this.currentTime = t
    this.ontimeupdate?.()
  }
}

/** Two media sections with DIFFERENT master clips — a seek from one into the
 *  other takes the slow "open" path. Clip B is a frontier URL whose fetch we
 *  keep PENDING to observe the mid-resolve progress value. */
// Source-clip identity is derived from the attachment KEY (a fileId-seeded
// audioId) — the two sections carry different fileId-seeded clips so a seek
// between them is a cross-clip "open".
const cells: CellData[] = [
  {
    id: "cA", fileId: "f1", original: "", translated: "", medium: "media", startTime: 0, endTime: 10,
    attachments: { "audio-f1-1690000000-clipa.mp3": { type: "audio", url: CLIP_A } },
  },
  {
    id: "cB", fileId: "f1", original: "", translated: "", medium: "media", startTime: 10, endTime: 20,
    attachments: {
      "audio-f1-1690000001-clipb.webm": {
        type: "audio",
        url: buildFrontierAudioUrl("audio-f1-1690000001-clipb", "webm"),
      },
    },
  },
] as unknown as CellData[]

const ctx: PlayContext = {
  cells,
  projectId: "p1",
  session: { jwt: "t", username: "dev", createdAt: "" } as PlayContext["session"],
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0))
}

describe("cross-clip seek progress reseed", () => {
  beforeEach(() => {
    FakeAudio.instances = []
    vi.stubGlobal("Audio", FakeAudio)
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:x", revokeObjectURL: () => {} }))
    setQueueTimingMode("dubbing")
    fetchCellAudio.mockReturnValue(new Promise(() => {})) // clip B never resolves
  })
  afterEach(() => {
    stopQueue()
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it("the readout carries the seek target through the whole resolve — never 0", async () => {
    startQueue(ctx, 0)
    await settle()
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "cA" })
    FakeAudio.instances[0]!.tick(5)
    expect(getQueueProgress().currentTime).toBe(5)

    seekQueueToTime(15) // into cB — different clip, open path, fetch pending
    // Synchronously after the seek: loading on cB, progress at the TARGET.
    expect(getQueueState()).toMatchObject({ kind: "loading", cellId: "cB" })
    expect(getQueueProgress().currentTime).toBe(15)
    await settle()
    // Still pending (fetch never resolves) — still parked at the target.
    expect(getQueueProgress().currentTime).toBe(15)
  })
})
