// AQU-646 SUB-53 — the AUDIO-FIRST transport.
//
// Both sides of a verse start together; whichever is shorter falls silent for
// the rest of the verse; the longer side clocks it and hands on to the next.
// There is no synthetic clock, so the thing worth testing hard is the HAND-OFF:
// who is driving, when the other one goes quiet, and that "quiet" never reads
// as "the user paused".
//
// Element behaviour is driven by a fake <audio> — happy-dom's never fires a
// timeupdate, and the whole point here is what happens on those ticks.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  getQueueProgress,
  getQueueState,
  pauseQueue,
  resumeQueue,
  seekQueueToTime,
  setQueueTimingMode,
  skipForward,
  startQueue,
  stopQueue,
  updateQueueCells,
  type PlayContext,
} from "./play-queue"
import type { CellData } from "@/hooks/useCells"

const CLIP = "http://audio.test/imported.mp3" // direct URL → no token/network path

class FakeAudio {
  static instances: FakeAudio[] = []
  currentTime = 0
  duration = 600
  paused = true
  ended = false
  muted = false
  volume = 1
  playbackRate = 1
  src: string
  onended: (() => void) | null = null
  onerror: (() => void) | null = null
  ontimeupdate: (() => void) | null = null
  onloadedmetadata: (() => void) | null = null
  onplay: (() => void) | null = null
  onpause: (() => void) | null = null
  constructor(src: string) {
    this.src = src
    FakeAudio.instances.push(this)
    // A real element announces metadata shortly after the src is set, which is
    // when the queue applies a pending seek (Safari rejects earlier ones).
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
  /** Drive a timeupdate tick, the way a real element would ~4×/second. */
  tick(t: number): void {
    this.currentTime = t
    this.ontimeupdate?.()
  }
}

/** Let the transport's awaits (src resolution, overlay fire) settle. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await Promise.resolve()
  await new Promise((r) => setTimeout(r, 0))
}

const SOURCE_ID = "audio-f1-1690000000-shared.mp3"

/** A dubbed verse: source clip attached, a take selected with a real length. */
function verse(id: string, startTime: number, endTime: number, takeMs?: number): CellData {
  const takeId = `audio-${id}-1700000000-take.webm`
  return {
    id,
    fileId: "f1",
    original: "",
    translated: "",
    medium: "media",
    startTime,
    endTime,
    ...(takeMs != null ? { selectedAudioId: takeId } : {}),
    attachments: {
      ...(takeMs != null
        ? { [takeId]: { type: "audio", url: `http://audio.test/${id}.webm`, durationMs: takeMs } }
        : {}),
      [SOURCE_ID]: { type: "audio", url: CLIP },
    },
  } as unknown as CellData
}

const ctxFor = (cells: CellData[]): PlayContext => ({
  cells,
  projectId: "p1",
  session: { jwt: "t", username: "dev", createdAt: "" } as PlayContext["session"],
})

/** The element playing the imported file (the original side). */
const sourceEl = (): FakeAudio | undefined =>
  [...FakeAudio.instances].reverse().find((a) => a.src === CLIP)
/** The element playing a verse's dub. */
const dubEl = (id: string): FakeAudio | undefined =>
  [...FakeAudio.instances].reverse().find((a) => a.src.includes(`/${id}.webm`))

beforeEach(() => {
  FakeAudio.instances = []
  vi.stubGlobal("Audio", FakeAudio)
})

afterEach(() => {
  stopQueue()
  setQueueTimingMode("dubbing")
  vi.unstubAllGlobals()
})

describe("audio-first transport — both sides start together", () => {
  it("opens a verse with the original AND the translation at the same moment", async () => {
    // v1: original file 0-6 (6s), translation 11s → the translation is longer.
    const cells = [verse("v1", 0, 6, 11_000), verse("v2", 6, 16, 4_000)]
    setQueueTimingMode("audioFirst")
    startQueue(ctxFor(cells), 0)
    await settle()

    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "v1" })
    expect(sourceEl()?.paused).toBe(false)
    expect(dubEl("v1")?.paused).toBe(false)
    // The whole assembled length, not the imported file's.
    expect(getQueueProgress().duration).toBe(11 + 10)
  })

  it("the SHORTER side goes quiet without the programme reading as paused", async () => {
    const cells = [verse("v1", 0, 6, 11_000), verse("v2", 6, 16, 4_000)]
    setQueueTimingMode("audioFirst")
    startQueue(ctxFor(cells), 0)
    await settle()

    // The original runs out 6s into an 11s verse.
    sourceEl()!.tick(6)
    expect(sourceEl()!.paused).toBe(true)
    expect(getQueueState().kind).toBe("playing") // still going — the dub carries on
    expect(dubEl("v1")!.paused).toBe(false)

    // …and the dub is now the clock.
    dubEl("v1")!.tick(8)
    expect(getQueueProgress().currentTime).toBeCloseTo(8, 6)
  })

  it("the LONGER side clocks the verse and hands on to the next", async () => {
    const cells = [verse("v1", 0, 6, 11_000), verse("v2", 6, 16, 4_000)]
    setQueueTimingMode("audioFirst")
    startQueue(ctxFor(cells), 0)
    await settle()
    sourceEl()!.tick(6) // original done

    // The dub reaching its end ends the verse.
    dubEl("v1")!.tick(11)
    await settle()
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "v2" })
    // v2's original starts at file second 6 — the shared element seeks there.
    expect(sourceEl()!.currentTime).toBe(6)
    expect(dubEl("v2")?.paused).toBe(false)
  })

  it("when the ORIGINAL is the longer side, the dub goes quiet and the original ends the verse", async () => {
    // v2: original 10s, translation 4s.
    const cells = [verse("v1", 0, 6, 11_000), verse("v2", 6, 16, 4_000), verse("v3", 16, 20, 3_000)]
    setQueueTimingMode("audioFirst")
    startQueue(ctxFor(cells), 0)
    await settle()
    sourceEl()!.tick(6)
    dubEl("v1")!.tick(11)
    await settle()

    // Now on v2. Its dub stops at 4s in; the programme keeps running.
    dubEl("v2")!.tick(4)
    await settle()
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "v2" })

    // The original ending its window is what moves us on.
    sourceEl()!.tick(16)
    await settle()
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "v3" })
  })

  it("stops at the end of the last verse", async () => {
    const cells = [verse("v1", 0, 4, 2_000)]
    setQueueTimingMode("audioFirst")
    startQueue(ctxFor(cells), 0)
    await settle()
    sourceEl()!.tick(4)
    await settle()
    expect(getQueueState().kind).toBe("idle")
  })

  it("a verse with no dub yet is clocked by its original", async () => {
    const cells = [verse("v1", 0, 5), verse("v2", 5, 9, 2_000)]
    setQueueTimingMode("audioFirst")
    startQueue(ctxFor(cells), 0)
    await settle()
    expect(dubEl("v1")).toBeUndefined()
    expect(getQueueProgress().currentTime).toBe(0)
    sourceEl()!.tick(5)
    await settle()
    expect(getQueueState()).toMatchObject({ cellId: "v2" })
  })
})

describe("audio-first transport — pausing, seeking and re-flowing", () => {
  it("pausing stops BOTH sides even when the original has already gone quiet", async () => {
    const cells = [verse("v1", 0, 6, 11_000)]
    setQueueTimingMode("audioFirst")
    startQueue(ctxFor(cells), 0)
    await settle()
    sourceEl()!.tick(6) // original quiet, dub still going

    pauseQueue()
    expect(dubEl("v1")!.paused).toBe(true)
    expect(getQueueState().kind).toBe("paused")

    // Resuming brings back only the side that still has audio in this verse.
    getQueueProgress() // (clock sits at 6s into an 11s verse)
    await resumeQueue()
    expect(dubEl("v1")!.paused).toBe(false)
    expect(sourceEl()!.paused).toBe(true) // its part of the verse is over
    expect(getQueueState().kind).toBe("playing")
  })

  it("seeking uses PROGRAMME seconds and lands both clips correctly", async () => {
    const cells = [verse("v1", 0, 6, 11_000), verse("v2", 6, 16, 4_000)]
    setQueueTimingMode("audioFirst")
    startQueue(ctxFor(cells), 0)
    await settle()

    // Programme second 13 = 2s into v2 (which starts at 11).
    seekQueueToTime(13)
    await settle()
    expect(getQueueState()).toMatchObject({ cellId: "v2" })
    expect(getQueueProgress().currentTime).toBe(13)
    expect(sourceEl()!.currentTime).toBe(8) // file second 6 + 2s in
    expect(dubEl("v2")!.currentTime).toBe(2) // 2s into its own clip
  })

  it("seeking into the silent tail of a verse plays only the side that is left", async () => {
    const cells = [verse("v1", 0, 6, 11_000)]
    setQueueTimingMode("audioFirst")
    startQueue(ctxFor(cells), 0)
    await settle()
    const before = FakeAudio.instances.length

    seekQueueToTime(9) // past the original's 6s, still inside the 11s dub
    await settle()
    expect(dubEl("v1")!.currentTime).toBe(9)
    expect(sourceEl()!.paused).toBe(true)
    expect(FakeAudio.instances.length).toBeGreaterThanOrEqual(before)
  })

  it("skipping forward moves a whole verse", async () => {
    const cells = [verse("v1", 0, 6, 11_000), verse("v2", 6, 16, 4_000)]
    setQueueTimingMode("audioFirst")
    startQueue(ctxFor(cells), 0)
    await settle()
    skipForward()
    await settle()
    expect(getQueueState()).toMatchObject({ cellId: "v2" })
    expect(getQueueProgress().currentTime).toBe(11)
  })

  it("a trim re-flows the layout and keeps the transport on the same verse", async () => {
    const cells = [verse("v1", 0, 4, 12_000), verse("v2", 4, 8, 3_000)]
    setQueueTimingMode("audioFirst")
    startQueue(ctxFor(cells), 0)
    await settle()
    skipForward()
    await settle()
    expect(getQueueProgress().currentTime).toBe(12) // v2 sat after a 12s v1

    // Trim v1's take down to 5s — v2 slides left, and we stay on v2.
    const trimmed = [verse("v1", 0, 4, 12_000), verse("v2", 4, 8, 3_000)]
    const t = trimmed[0].attachments!["audio-v1-1700000000-take.webm"] as Record<string, number>
    t.trimStartMs = 1_000
    t.trimEndMs = 6_000
    updateQueueCells(trimmed)
    expect(getQueueState()).toMatchObject({ cellId: "v2" })
    expect(getQueueProgress().duration).toBe(5 + 4)
  })

  it("switching mode stops the transport rather than carrying a stale clock over", async () => {
    const cells = [verse("v1", 0, 6, 11_000)]
    setQueueTimingMode("audioFirst")
    startQueue(ctxFor(cells), 0)
    await settle()
    expect(getQueueState().kind).toBe("playing")

    setQueueTimingMode("dubbing")
    expect(getQueueState().kind).toBe("idle")
  })
})
