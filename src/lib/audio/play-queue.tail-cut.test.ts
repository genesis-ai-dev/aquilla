// AQU-1767 (Sam's walk, 2026-10-15): a trimmed dub plays bytes that END at its
// trim, so it stops there by itself. A timer alone ran 60-90ms over whenever
// the page was busy, and a cut falls mid-speech.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { encodeWavPcm16 } from "./wav-encode"

const cached = vi.hoisted(() => ({ bytes: null as Uint8Array | null }))
vi.mock("./bytes-cache", () => ({
  audioCacheGet: async () => cached.bytes,
  audioCachePut: async () => {},
}))
vi.mock("./upload", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getCellAudioStreamUrl: async () => "http://stream.test/a.webm",
}))

import { startExternalDubs, stopExternalDubs, tickExternalDubs, setExternalDubsPlaying, setQueueAudibility, type PlayContext } from "./play-queue"
import { __resetTailCutForTests } from "./tail-cut"
import type { CellData } from "@/hooks/useCells"

class FakeAudio {
  static instances: FakeAudio[] = []
  currentTime = 0
  duration = 4
  paused = true
  muted = false
  volume = 1
  playbackRate = 1
  readyState = 4
  src: string
  onended: (() => void) | null = null
  onerror: (() => void) | null = null
  ontimeupdate: (() => void) | null = null
  onloadedmetadata: (() => void) | null = null
  oncanplay: (() => void) | null = null
  constructor(src: string) {
    this.src = src
    FakeAudio.instances.push(this)
  }
  async play(): Promise<void> { this.paused = false }
  pause(): void { this.paused = true }
  addEventListener(): void {}
  removeEventListener(): void {}
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
  await new Promise((r) => setTimeout(r, 0))
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

const TAKE = "audio-a-1700000000-take"
function line(ext: string, trimEndMs?: number): CellData {
  return {
    id: "a", fileId: "f1", original: "", translated: "", medium: "text", startTime: 10, endTime: 20,
    selectedAudioId: `${TAKE}.${ext}`,
    attachments: {
      [`${TAKE}.${ext}`]: { type: "audio", url: `frontier-audio://${TAKE}.${ext}`, durationMs: 4000, ...(trimEndMs != null ? { trimEndMs } : {}) },
    },
  } as unknown as CellData
}
const ctxFor = (cells: CellData[]): PlayContext => ({
  cells, projectId: "p1", session: { jwt: "t", username: "dev", createdAt: "" } as PlayContext["session"],
})

let blobs: Blob[] = []
beforeEach(async () => {
  FakeAudio.instances = []
  blobs = []
  __resetTailCutForTests()
  cached.bytes = new Uint8Array(await encodeWavPcm16(new Float32Array(48000 * 4), 48000).arrayBuffer())
  vi.stubGlobal("Audio", FakeAudio)
  vi.spyOn(URL, "createObjectURL").mockImplementation((b) => { blobs.push(b as Blob); return `blob:test/${blobs.length}` })
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {})
  setQueueAudibility({ source: true, target: true })
})
afterEach(() => {
  stopExternalDubs()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("a trimmed dub's bytes end at its trim", () => {
  it("plays a WAV cut at the trim end, so it stops there by itself", async () => {
    startExternalDubs(ctxFor([line("wav", 1500)]))
    setExternalDubsPlaying(true)
    tickExternalDubs(10.1)
    await settle()
    const el = FakeAudio.instances.at(-1)!
    const played = blobs[Number(el.src.split("/").pop()) - 1]
    // 1.5s of 48kHz mono 16-bit, after its 44-byte header.
    expect(played.size).toBe(44 + 1.5 * 48000 * 2)
  })

  it("plays a dub with no trim end whole", async () => {
    startExternalDubs(ctxFor([line("wav")]))
    setExternalDubsPlaying(true)
    tickExternalDubs(10.1)
    await settle()
    const el = FakeAudio.instances.at(-1)!
    expect(blobs[Number(el.src.split("/").pop()) - 1].size).toBe(44 + 4 * 48000 * 2)
  })

  it("streams an uncached dub as before, stopped by the timer", async () => {
    cached.bytes = null
    startExternalDubs(ctxFor([line("wav", 1500)]))
    setExternalDubsPlaying(true)
    tickExternalDubs(10.1)
    await settle()
    expect(FakeAudio.instances.at(-1)!.src).toBe("http://stream.test/a.webm")
  })
})
