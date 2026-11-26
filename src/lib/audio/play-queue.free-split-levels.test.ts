// AQU-2494 (review, Nov 9): following the recordings, a cut take plays as one
// joined copy. It was levelled by its FIRST piece's volume and fades, on the
// first piece's clock in the original recording: a fade-out landed at the cut
// and everything after it was silent, and a head-trimmed take with a fade-in
// was silent at its start. Each piece now plays at its own level, where it
// sits in the joined copy.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { encodeWavPcm16 } from "./wav-encode"

const cached = vi.hoisted(() => ({ bytes: null as Uint8Array | null }))
vi.mock("./bytes-cache", () => ({
  audioCacheGet: async () => cached.bytes,
  audioCachePut: async () => {},
}))
const mixed = vi.hoisted(() => ({ calls: [] as Array<{ src: string; level: unknown }> }))
vi.mock("./mixer", async (orig) => ({
  ...(await orig<typeof import("./mixer")>()),
  mixElement: (el: { src: string }, _track: string, level: unknown) => {
    mixed.calls.push({ src: el.src, level })
    return true
  },
}))

import { levelAt, type ClipLevel } from "./mixer"
import { setQueueTimingMode, startQueue, stopQueue, type PlayContext } from "./play-queue"
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
const G6 = Math.pow(10, 6 / 20)

/** A 5 s take cut at 2.5 s, with each piece's stored trim and level. */
const cutLine = (first: Record<string, unknown>, second: Record<string, unknown>) =>
  ({
    id: "a", fileId: "f1", original: "", translated: "", medium: "media", startTime: 0, endTime: 1,
    selectedAudioId: `${TAKE}.wav`,
    attachments: {
      [`${TAKE}.wav`]: { type: "audio", url: `frontier-audio://${TAKE}.wav`, slot: "recording", durationMs: 5000, trimEndMs: 2500, ...first },
      [`${PIECE}.wav`]: { type: "audio", url: `frontier-audio://${TAKE}.wav`, slot: "recording", pieceOf: `${TAKE}.wav`, durationMs: 5000, trimStartMs: 2500, ...second },
    },
  }) as unknown as CellData

const ctxFor = (cells: CellData[]): PlayContext => ({
  cells, projectId: "p1", session: { jwt: "t", username: "dev", createdAt: "" } as PlayContext["session"],
})

/** Play the line following the recordings; the level its joined copy was given. */
async function joinedLevel(cell: CellData): Promise<ClipLevel | readonly ClipLevel[] | null> {
  setQueueTimingMode("audioFirst")
  startQueue(ctxFor([cell]), 0)
  await settle()
  const dub = FakeAudio.instances.find((a) => a.src.startsWith("blob:test/"))!
  expect(dub).toBeTruthy()
  const call = mixed.calls.filter((c) => c.src === dub.src).at(-1)!
  expect(call).toBeTruthy()
  return call.level as ClipLevel | readonly ClipLevel[] | null
}

beforeEach(async () => {
  FakeAudio.instances = []
  mixed.calls.length = 0
  cached.bytes = new Uint8Array(await encodeWavPcm16(new Float32Array(48000 * 5), 48000).arrayBuffer())
  vi.stubGlobal("Audio", FakeAudio)
  let n = 0
  vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:test/${++n}`)
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {})
})
afterEach(() => {
  stopQueue()
  setQueueTimingMode("dubbing")
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("following the recordings, a cut take with a volume change and fades", () => {
  it("plays every piece at its volume, with the fade-out at the take's end", async () => {
    // +6 dB and a 0.5 s fade-out, as a cut leaves them on the pieces.
    const level = await joinedLevel(cutLine({ gainDb: 6 }, { gainDb: 6, fadeOutMs: 500 }))
    expect(level).not.toBeNull()
    expect(levelAt(1, level!)).toBeCloseTo(G6, 5)
    // Past the cut: still sounding, at the take's volume.
    expect(levelAt(2.6, level!)).toBeCloseTo(G6, 5)
    expect(levelAt(4, level!)).toBeCloseTo(G6, 5)
    // The fade-out over the last half second of the joined copy.
    expect(levelAt(4.75, level!)).toBeCloseTo(G6 / 2, 5)
    expect(levelAt(5, level!)).toBe(0)
  })

  it("a head-trimmed take's fade-in starts where its sound starts", async () => {
    // Start trimmed to 1.0 s, a 0.5 s fade-in: the joined copy starts there.
    const level = await joinedLevel(cutLine({ trimStartMs: 1000, fadeInMs: 500 }, {}))
    expect(level).not.toBeNull()
    expect(levelAt(0, level!)).toBe(0)
    expect(levelAt(0.25, level!)).toBeCloseTo(0.5, 5)
    expect(levelAt(1, level!)).toBeCloseTo(1, 5)
    expect(levelAt(3, level!)).toBeCloseTo(1, 5)
  })

  it("each piece keeps a volume of its own", async () => {
    const level = await joinedLevel(cutLine({ gainDb: -6 }, {}))
    expect(levelAt(1, level!)).toBeCloseTo(Math.pow(10, -6 / 20), 5)
    expect(levelAt(3, level!)).toBeCloseTo(1, 5)
  })

  it("a cut take as recorded is mixed as recorded", async () => {
    expect(await joinedLevel(cutLine({}, {}))).toBeNull()
  })
})
