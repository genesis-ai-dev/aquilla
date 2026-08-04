// AQU-784 repro: pressing Play on a SELECTED mid-clip media section must begin
// playback at that section's window start, not at the beginning of the shared
// imported clip. Drives the real startQueue → playAt path against a fake
// <audio> element so the loadedmetadata seek is actually exercised (the pure
// planner tests in play-queue.seek.test.ts don't touch the element).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { CellData } from "@/hooks/useCells"
import type { FrontierSession } from "@/lib/frontier/types"

// Fake <audio>: stores currentTime as a plain field and lets the test drive the
// metadata-load lifecycle the queue's seek depends on.
class FakeAudio {
  static instances: FakeAudio[] = []
  src: string
  paused = true
  ended = false
  currentTime = 0
  duration = NaN
  playbackRate = 1
  volume = 1
  onloadedmetadata: (() => void) | null = null
  onended: (() => void) | null = null
  ontimeupdate: (() => void) | null = null
  ondurationchange: (() => void) | null = null
  onpause: (() => void) | null = null
  onplay: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor(src: string) {
    this.src = src
    FakeAudio.instances.push(this)
  }
  play(): Promise<void> { this.paused = false; this.onplay?.(); return Promise.resolve() }
  pause(): void { this.paused = true; this.onpause?.() }
  /** Simulate the element loading metadata (fires the seek). */
  loadMetadata(duration: number): void {
    this.duration = duration
    this.onloadedmetadata?.()
    this.ondurationchange?.()
  }
}

vi.stubGlobal("Audio", FakeAudio)

import { startQueue, stopQueue, getQueueState } from "./play-queue"

const CLIP = "blob:shared-clip" // plain URL → resolveAudioSrc returns it directly, no fetch

const session = { jwt: "jwt", username: "u" } as unknown as FrontierSession

let nextId = 0
const mediaCell = (startTime: number, endTime: number): CellData =>
  ({
    id: `c${++nextId}`, fileId: "f1", original: "", translated: "", context: "", group: "",
    type: "text", status: "empty", validationStatus: "none",
    activeValidators: [], validationHistory: [], history: [], threads: [],
    medium: "media", startTime, endTime,
    selectedAudioId: "a1",
    attachments: { a1: { type: "audio", url: CLIP } },
  }) as unknown as CellData

// A media section whose in-clip slice lives on the attachment's persisted trim
// window (trimStartMs/trimEndMs) while the cell's timeline placement diverges —
// the real shape after a `cell.retime` drag, or an import that timed the
// attachment but not the cell. `startTime`/`endTime` here are deliberately WRONG.
const trimOnlyCell = (
  trimStartMs: number, trimEndMs: number, wrongStart: number, wrongEnd: number,
): CellData =>
  ({
    id: `c${++nextId}`, fileId: "f1", original: "", translated: "", context: "", group: "",
    type: "text", status: "empty", validationStatus: "none",
    activeValidators: [], validationHistory: [], history: [], threads: [],
    medium: "media", startTime: wrongStart, endTime: wrongEnd,
    selectedAudioId: "a1",
    attachments: { a1: { type: "audio", url: CLIP, trimStartMs, trimEndMs } },
  }) as unknown as CellData

describe("AQU-784 — Play on a selected media section starts at its window", () => {
  beforeEach(() => { FakeAudio.instances = []; nextId = 0 })
  afterEach(() => { stopQueue() })

  it("starts a mid-clip section at its window start, not the clip beginning", async () => {
    // Three tiled sections partitioning one 30s imported clip.
    const cells = [mediaCell(0, 10), mediaCell(10, 22), mediaCell(22, 30)]

    // Bottom Play with section index 1 highlighted (VoicePlaybackBar hands the
    // queue this index for a mid-clip selection).
    startQueue({ cells, projectId: "p1", session }, 1, /* explicit */ true)

    await vi.waitFor(() => expect(FakeAudio.instances.length).toBe(1))
    const audio = FakeAudio.instances[0]
    audio.loadMetadata(30)

    expect(getQueueState().kind).toBe("playing")
    // The whole point of AQU-666/AQU-784: playback begins at the section window
    // start (10s), NOT 0.
    expect(audio.currentTime).toBe(10)
  })

  it("still starts the first section at 0 (no off-by-one)", async () => {
    const cells = [mediaCell(0, 10), mediaCell(10, 22), mediaCell(22, 30)]
    startQueue({ cells, projectId: "p1", session }, 0, true)
    await vi.waitFor(() => expect(FakeAudio.instances.length).toBe(1))
    FakeAudio.instances[0].loadMetadata(30)
    expect(FakeAudio.instances[0].currentTime).toBe(0)
  })

  // AQU-784 root cause: the section's true in-clip window is the attachment's
  // persisted trim (10s), while the cell's timeline placement has drifted to 0
  // (a retime, or a trim-on-attachment-only import). Playback MUST honor the
  // attachment slice — otherwise it plays from the start of the whole clip,
  // which is exactly the reported symptom that keeps bouncing back.
  it("honors the attachment trim window when the cell placement diverges", async () => {
    const cells = [trimOnlyCell(10_000, 22_000, /* wrong */ 0, 0)]
    startQueue({ cells, projectId: "p1", session }, 0, true)
    await vi.waitFor(() => expect(FakeAudio.instances.length).toBe(1))
    FakeAudio.instances[0].loadMetadata(30)
    expect(FakeAudio.instances[0].currentTime).toBe(10)
  })
})
