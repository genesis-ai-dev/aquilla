// AQU-2494 (review, Nov 9), finding 8: on the main player of a text line (the
// line's take playing as the master, following the source), a cut take's
// volume and fades came from whichever piece was listed first — every piece
// shares the recording's URL, and the player looked the take up by it. One
// order lost the fade-out, the other the fade-in, and a cut made before the
// fix (its first piece holding all three levels) was silent from the cut to
// the end. Each piece now plays at its own level, where it sits.
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

import { levelAt, type ClipLevels } from "./mixer"
import { setQueueTimingMode, startQueue, stopQueue, type PlayContext } from "./play-queue"
import type { CellData } from "@/hooks/useCells"

class FakeAudio {
  static instances: FakeAudio[] = []
  currentTime = 0
  duration = 5
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

/** A text line whose 5 s take was cut at 2.5 s; `secondFirst` lists the new piece first. */
const cutTextLine = (first: Record<string, unknown>, second: Record<string, unknown>, secondFirst = false) => {
  const a: [string, Record<string, unknown>] = [`${TAKE}.wav`, { type: "audio", url: `frontier-audio://${TAKE}.wav`, slot: "recording", durationMs: 5000, trimEndMs: 2500, ...first }]
  const b: [string, Record<string, unknown>] = [`${PIECE}.wav`, { type: "audio", url: `frontier-audio://${TAKE}.wav`, slot: "recording", pieceOf: `${TAKE}.wav`, durationMs: 5000, trimStartMs: 2500, ...second }]
  return {
    id: "a", fileId: "f1", original: "", translated: "",
    selectedAudioId: `${TAKE}.wav`,
    attachments: Object.fromEntries(secondFirst ? [b, a] : [a, b]),
  } as unknown as CellData
}

const ctxFor = (cells: CellData[]): PlayContext => ({
  cells, projectId: "p1", session: { jwt: "t", username: "dev", createdAt: "" } as PlayContext["session"],
})

/** Play the line following the source; the level its main player was given. */
async function masterLevel(cell: CellData): Promise<ClipLevels | null> {
  setQueueTimingMode("dubbing")
  startQueue(ctxFor([cell]), 0)
  await settle()
  const master = FakeAudio.instances[0]
  expect(master).toBeTruthy()
  const call = mixed.calls.filter((c) => c.src === master.src).at(-1)!
  expect(call).toBeTruthy()
  return call.level as ClipLevels | null
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
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("a text line's take playing as the main player, cut, with a volume change and fades", () => {
  // +6 dB, a 0.3 s fade-in and a 0.5 s fade-out, as the cut leaves them.
  const first = { gainDb: 6, fadeInMs: 300 }
  const second = { gainDb: 6, fadeOutMs: 500 }

  it("the first piece listed first: the fade-in, the volume past the cut, and the fade-out at the take's end", async () => {
    const level = await masterLevel(cutTextLine(first, second))
    expect(levelAt(0.15, level!)).toBeCloseTo(G6 / 2, 5)
    expect(levelAt(2.6, level!)).toBeCloseTo(G6, 5)
    expect(levelAt(4.75, level!)).toBeCloseTo(G6 / 2, 5)
  })

  it("the new piece listed first: the same", async () => {
    const level = await masterLevel(cutTextLine(first, second, true))
    expect(levelAt(0.15, level!)).toBeCloseTo(G6 / 2, 5)
    expect(levelAt(2.6, level!)).toBeCloseTo(G6, 5)
    expect(levelAt(4.75, level!)).toBeCloseTo(G6 / 2, 5)
  })

  it("a cut made before the fix (all three levels on the first piece) is never silent after the cut: it plays on as recorded", async () => {
    const level = await masterLevel(cutTextLine({ gainDb: 6, fadeInMs: 300, fadeOutMs: 500 }, {}))
    // The first piece fades out at the cut, as its stored level says…
    expect(levelAt(1, level!)).toBeCloseTo(G6, 5)
    expect(levelAt(2.25, level!)).toBeCloseTo(G6 / 2, 5)
    // …and the second, which holds no level of its own, plays as recorded.
    expect(levelAt(2.6, level!)).toBe(1)
    expect(levelAt(4, level!)).toBe(1)
  })

  it("a whole take keeps its one level", async () => {
    const cell = {
      id: "a", fileId: "f1", original: "", translated: "", selectedAudioId: `${TAKE}.wav`,
      attachments: { [`${TAKE}.wav`]: { type: "audio", url: `frontier-audio://${TAKE}.wav`, slot: "recording", durationMs: 5000, gainDb: -6 } },
    } as unknown as CellData
    const level = await masterLevel(cell)
    expect(levelAt(2, level!)).toBeCloseTo(Math.pow(10, -6 / 20), 5)
  })
})
