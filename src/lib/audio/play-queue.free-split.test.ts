// AQU-1767 (Sam, 2026-10-15): Free timing plays a split take as ONE take — its
// pieces' audio joined into one clip, back to back, so nothing skips between
// them and nothing can overrun into the audio between pieces.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { encodeWavPcm16 } from "./wav-encode"

const cached = vi.hoisted(() => ({ bytes: null as Uint8Array | null }))
vi.mock("./bytes-cache", () => ({
  audioCacheGet: async () => cached.bytes,
  audioCachePut: async () => {},
}))

import { getQueueProgress, setQueueTimingMode, startQueue, stopQueue, type PlayContext } from "./play-queue"
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
  error = null
  src: string
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
const PIECE = "audio-a-1700000500-piece"
const CLIP = "http://audio.test/imported.mp3"
const SOURCE_ID = "audio-f1-1690000000-shared.mp3"

/** A 1s line whose 4s take was split, then trimmed to 0.2–1.5s and 2.5–3.7s. */
const line = {
  id: "a", fileId: "f1", original: "", translated: "", medium: "media", startTime: 0, endTime: 1,
  selectedAudioId: `${TAKE}.wav`,
  attachments: {
    [`${TAKE}.wav`]: { type: "audio", url: `frontier-audio://${TAKE}.wav`, slot: "recording", durationMs: 4000, trimStartMs: 200, trimEndMs: 1500 },
    [`${PIECE}.wav`]: { type: "audio", url: `frontier-audio://${TAKE}.wav`, slot: "recording", pieceOf: `${TAKE}.wav`, durationMs: 4000, trimStartMs: 2500, trimEndMs: 3700 },
    [SOURCE_ID]: { type: "audio", url: CLIP },
  },
} as unknown as CellData

const ctxFor = (cells: CellData[]): PlayContext => ({
  cells, projectId: "p1", session: { jwt: "t", username: "dev", createdAt: "" } as PlayContext["session"],
})

let blobs: Blob[] = []
beforeEach(async () => {
  FakeAudio.instances = []
  blobs = []
  cached.bytes = new Uint8Array(await encodeWavPcm16(new Float32Array(48000 * 4), 48000).arrayBuffer())
  vi.stubGlobal("Audio", FakeAudio)
  vi.spyOn(URL, "createObjectURL").mockImplementation((b) => { blobs.push(b as Blob); return `blob:test/${blobs.length}` })
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {})
})
afterEach(() => {
  stopQueue()
  setQueueTimingMode("dubbing")
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("Free timing — a split take", () => {
  it("plays both pieces as one joined clip and gives the line their whole length", async () => {
    setQueueTimingMode("audioFirst")
    startQueue(ctxFor([line]), 0)
    await settle()
    const dub = FakeAudio.instances.find((a) => a.src.startsWith("blob:test/"))!
    expect(dub).toBeTruthy()
    // 1.3s + 1.2s of 48kHz mono 16-bit, after its 44-byte header.
    expect(blobs[Number(dub.src.split("/").pop()) - 1].size).toBe(44 + 2.5 * 48000 * 2)
    // The line runs as long as both pieces together, not its first piece.
    expect(getQueueProgress().duration).toBeCloseTo(2.5)
  })

  // AQU-1758 (Sam's decision 3): a gap someone dragged open between two
  // pieces is deliberate silence, and it plays as silence.
  it("plays a gap dragged open between the pieces as silence", async () => {
    const placed = {
      ...line,
      attachments: {
        ...line.attachments,
        // Moved 0.7 s along from the end of the first piece.
        [`${PIECE}.wav`]: { ...line.attachments![`${PIECE}.wav`], targetOffsetMs: 700 },
      },
    } as unknown as CellData
    setQueueTimingMode("audioFirst")
    startQueue(ctxFor([placed]), 0)
    await settle()
    const dub = FakeAudio.instances.find((a) => a.src.startsWith("blob:test/"))!
    // 1.3 s, then 0.7 s of silence, then 1.2 s.
    expect(blobs[Number(dub.src.split("/").pop()) - 1].size).toBe(44 + 3.2 * 48000 * 2)
    expect(getQueueProgress().duration).toBeCloseTo(3.2)
  })
})
