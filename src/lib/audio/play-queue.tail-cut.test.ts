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

// AQU-1767 (Sam's walk, 2026-10-15): a split take cleaned by Remove noise is a
// webm, which states no length, so the queue would not seek it — and every
// piece but the first played from the recording's head ("test one" where
// "test three" was due). A dub that must start partway in gets a WAV first.
describe("a dub that starts partway into a webm", () => {
  class FakeOffline {
    sampleRate: number
    constructor(_c: number, _l: number, sampleRate: number) { this.sampleRate = sampleRate }
    async decodeAudioData() {
      const length = 4 * this.sampleRate
      return { sampleRate: this.sampleRate, length, numberOfChannels: 1, getChannelData: () => new Float32Array(length) }
    }
  }
  let decodes = 0
  beforeEach(() => {
    decodes = 0
    vi.stubGlobal("OfflineAudioContext", class extends FakeOffline {
      async decodeAudioData() { decodes += 1; return super.decodeAudioData() }
    })
  })

  it("plays a WAV of it, cut at its trim end, so the seek to its start can happen", async () => {
    cached.bytes = new Uint8Array(64) // a webm's bytes; decoded by the fake
    const piece = {
      ...line("webm", 3000),
      attachments: { [`${TAKE}.webm`]: { type: "audio", url: `frontier-audio://${TAKE}.webm`, durationMs: 4000, trimStartMs: 1500, trimEndMs: 3000 } },
    } as unknown as CellData
    startExternalDubs(ctxFor([piece]))
    setExternalDubsPlaying(true)
    // 11.6s: 0.1s into a piece that starts 1.5s into its recording.
    tickExternalDubs(11.6)
    await settle()
    const el = FakeAudio.instances.at(-1)!
    const played = blobs[Number(el.src.split("/").pop()) - 1]
    expect(played.type).toBe("audio/wav")
    expect(played.size).toBe(44 + 3 * 48000 * 2)
  })

  it("gets the take's next piece ready while the first one plays", async () => {
    cached.bytes = new Uint8Array(64)
    const A = `${TAKE}.webm`, B = "audio-a-1700000500-piece.webm"
    const split = {
      ...line("webm"),
      selectedAudioId: A,
      attachments: {
        [A]: { type: "audio", url: `frontier-audio://${TAKE}.webm`, slot: "recording", durationMs: 4000, trimEndMs: 1500 },
        [B]: { type: "audio", url: `frontier-audio://${TAKE}.webm`, slot: "recording", pieceOf: A, durationMs: 4000, trimStartMs: 2000, trimEndMs: 3500 },
      },
    } as unknown as CellData
    startExternalDubs(ctxFor([split]))
    setExternalDubsPlaying(true)
    tickExternalDubs(10.2)
    await settle()
    // The first piece's clip, and the second's, made while the first plays.
    expect(decodes).toBe(2)
    tickExternalDubs(12.1)
    await settle()
    // Due, the second piece waits for nothing new.
    expect(decodes).toBe(2)
    const el = FakeAudio.instances.at(-1)!
    expect(blobs[Number(el.src.split("/").pop()) - 1].size).toBe(44 + 3.5 * 48000 * 2)
  })
})

// AQU-1767 (Sam's walk, 2026-10-15): the piece after a cut sounded after its
// waveform began — its player was made when it was due, and a fresh player
// takes time to sound. It is now made and loaded while the piece before plays.
describe("the next piece of a split take", () => {
  it("is made and parked at its start while the piece before it plays, then adopted when due", async () => {
    const A = `${TAKE}.wav`, B = "audio-a-1700000500-piece.wav"
    const split = {
      ...line("wav"),
      selectedAudioId: A,
      attachments: {
        [A]: { type: "audio", url: `frontier-audio://${TAKE}.wav`, slot: "recording", durationMs: 4000, trimEndMs: 1500 },
        [B]: { type: "audio", url: `frontier-audio://${TAKE}.wav`, slot: "recording", pieceOf: A, durationMs: 4000, trimStartMs: 2000, trimEndMs: 3500 },
      },
    } as unknown as CellData
    startExternalDubs(ctxFor([split]))
    setExternalDubsPlaying(true)
    tickExternalDubs(10.2)
    await settle()
    // A plays; B's player is already made.
    expect(FakeAudio.instances).toHaveLength(2)
    const sizeOf = (el: FakeAudio) => blobs[Number(el.src.split("/").pop()) - 1].size
    // B's clip ends at its trim end, 3.5s in.
    const stocked = FakeAudio.instances.find((el) => sizeOf(el) === 44 + 3.5 * 48000 * 2)!
    expect(stocked).toBeTruthy()
    expect(stocked.paused).toBe(true)
    // Ordinary playback, a tick at a time, up to B's start.
    for (const t of [10.45, 10.7, 10.95, 11.2, 11.45, 11.7, 11.95, 12.1]) tickExternalDubs(t)
    await settle()
    // B is due: that player sounds, and no new one is made for it.
    expect(FakeAudio.instances).toHaveLength(2)
    expect(stocked.paused).toBe(false)
  })
})

