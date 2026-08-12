// AQU-646 round 5: recorded takes sounding over a LINKED PICTURE.
//
// The workflow's whole point is dubbing to film, and until this round a take
// recorded against the picture could not be played back against it — the queue
// is the only thing that fires dub overlays, and on a subtitle file timed
// against footage its master element has nothing to play.
//
// The engine is reused, not rebuilt: `planTargetOverlay` already takes the
// master's second as a plain parameter, and the pool, trims, byte-resolution
// and the Target speaker button are all clock-agnostic. Only the ticker
// changes. These tests drive that ticker with fake elements, which matters
// because the dubbing fire path has NO fake-element coverage at all today —
// it is pinned only by browser passes.
//
// Harness deliberately mirrors play-queue.programme.test.ts: happy-dom's media
// elements never fire timeupdate, so a fake is the only way to assert timing.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import {
  startExternalDubs,
  stopExternalDubs,
  tickExternalDubs,
  setExternalDubsPlaying,
  updateExternalDubCells,
  getExternalDubsSnapshot,
  setQueueAudibility,
  planTargetOverlay,
  type PlayContext,
} from "./play-queue"
import type { CellData } from "@/hooks/useCells"

class FakeAudio {
  static instances: FakeAudio[] = []
  /** A MediaRecorder webm reports Infinity until the whole clip is indexed. */
  static duration = 600
  seekLog: number[] = []
  #currentTime = 0
  get currentTime(): number { return this.#currentTime }
  set currentTime(v: number) {
    this.seekLog.push(v)
    this.#currentTime = v
  }
  duration = FakeAudio.duration
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
  onplay: (() => void) | null = null
  onpause: (() => void) | null = null
  constructor(src: string) {
    this.src = src
    FakeAudio.instances.push(this)
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
  addEventListener(): void {}
  removeEventListener(): void {}
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await Promise.resolve()
  await new Promise((r) => setTimeout(r, 0))
}

/**
 * A video-first line: `medium: "text"` (a VTT import makes no media cells) with
 * a recorded take and NO source clip. This shape is exactly what the dubbing
 * arrangement refuses to fire for, and exactly what must fire here.
 */
function line(id: string, startTime: number, endTime: number, takeMs?: number): CellData {
  const takeId = `audio-${id}-1700000000-take.webm`
  return {
    id,
    fileId: "f1",
    original: "",
    translated: "",
    medium: "text",
    startTime,
    endTime,
    ...(takeMs != null ? { selectedAudioId: takeId } : {}),
    attachments:
      takeMs != null
        ? { [takeId]: { type: "audio", url: `http://audio.test/${id}.webm`, durationMs: takeMs } }
        : {},
  } as unknown as CellData
}

const ctxFor = (cells: CellData[]): PlayContext => ({
  cells,
  projectId: "p1",
  session: { jwt: "t", username: "dev", createdAt: "" } as PlayContext["session"],
})

const dubEl = (id: string): FakeAudio | undefined =>
  [...FakeAudio.instances].reverse().find((a) => a.src.includes(`/${id}.webm`))

const poolIds = (): string[] => getExternalDubsSnapshot().pool.map((e) => e.cellId)

beforeEach(() => {
  FakeAudio.instances = []
  FakeAudio.duration = 600
  vi.stubGlobal("Audio", FakeAudio)
  setQueueAudibility({ source: true, target: true })
})

afterEach(() => {
  stopExternalDubs()
  vi.unstubAllGlobals()
})

describe("dubs driven by a linked picture", () => {
  it("a take on a TEXT cell sounds — the case the queue refuses", async () => {
    // The dubbing arrangement's gate says a cell with no source clip is not a
    // section of the master timeline. With a picture, every cue is.
    const cells = [line("a", 10, 12, 1500)]
    startExternalDubs(ctxFor(cells))
    setExternalDubsPlaying(true)
    tickExternalDubs(10.1)
    await settle()

    expect(poolIds()).toEqual(["a"])
    expect(dubEl("a")?.paused).toBe(false)
  })

  it("...and the dubbing arrangement still refuses it, untouched", () => {
    // The guard on the parameterised gate: same cell, no external master.
    const cells = [line("a", 10, 12, 1500)]
    expect(planTargetOverlay(cells, 0, new Set(), "advance", 10.1).kind).toBe("keep")
    expect(planTargetOverlay(cells, 0, new Set(), "advance", 10.1, { masterIsExternal: true }).kind).toBe("fire")
  })

  it("does not fire before the take is due", async () => {
    startExternalDubs(ctxFor([line("a", 10, 12, 1500)]))
    setExternalDubsPlaying(true)
    tickExternalDubs(4)
    await settle()
    expect(poolIds()).toEqual([])
  })

  it("does not re-fire a dub that is already sounding", async () => {
    startExternalDubs(ctxFor([line("a", 10, 12, 4000)]))
    setExternalDubsPlaying(true)
    tickExternalDubs(10.1)
    await settle()
    const first = dubEl("a")
    // Four more ticks inside the same dub, as ordinary playback would produce.
    for (const t of [10.35, 10.6, 10.85, 11.1]) tickExternalDubs(t)
    await settle()
    expect(poolIds()).toEqual(["a"])
    expect(dubEl("a")).toBe(first)
  })

  it("stops firing once the take's audible extent has passed", async () => {
    // A 1s take on a 10s line: at 15s there is nothing left of it to hear.
    startExternalDubs(ctxFor([line("a", 10, 20, 1000)]))
    setExternalDubsPlaying(true)
    tickExternalDubs(15)
    await settle()
    expect(poolIds()).toEqual([])
  })

  it("two takes overlapping in time both sound", async () => {
    // Real dialogue overlaps, and the timeline lets takes be nudged across
    // each other deliberately.
    startExternalDubs(ctxFor([line("a", 10, 14, 4000), line("b", 11, 15, 4000)]))
    setExternalDubsPlaying(true)
    tickExternalDubs(11.5)
    await settle()
    expect(poolIds().sort()).toEqual(["a", "b"])
  })

  it("a SCRUB re-cues rather than leaving the old dub ringing", async () => {
    startExternalDubs(ctxFor([line("a", 10, 20, 8000), line("b", 100, 108, 4000)]))
    setExternalDubsPlaying(true)
    tickExternalDubs(10.1)
    await settle()
    expect(poolIds()).toEqual(["a"])

    // Jump to another part of the film: a's dub belongs to where we were.
    tickExternalDubs(100.2)
    await settle()
    expect(poolIds()).toEqual(["b"])
  })

  it("ordinary playback across a boundary is NOT treated as a scrub", async () => {
    // The slop has to clear timeupdate's ~250ms comfortably, or every tick
    // would tear down a ringing dub.
    startExternalDubs(ctxFor([line("a", 10, 12, 4000)]))
    setExternalDubsPlaying(true)
    tickExternalDubs(10.1)
    await settle()
    const first = dubEl("a")
    tickExternalDubs(10.35)
    await settle()
    expect(dubEl("a")).toBe(first)
    expect(poolIds()).toEqual(["a"])
  })

  it("pausing the picture pauses the dub, and resuming resumes it", async () => {
    startExternalDubs(ctxFor([line("a", 10, 20, 8000)]))
    setExternalDubsPlaying(true)
    tickExternalDubs(10.1)
    await settle()
    expect(dubEl("a")?.paused).toBe(false)

    setExternalDubsPlaying(false)
    expect(dubEl("a")?.paused).toBe(true)

    setExternalDubsPlaying(true)
    await settle()
    expect(dubEl("a")?.paused).toBe(false)
  })

  it("a dub cued while the picture is PAUSED does not start on its own", async () => {
    // Scrubbing a paused film should not make it talk.
    startExternalDubs(ctxFor([line("a", 10, 20, 8000)]))
    setExternalDubsPlaying(false)
    tickExternalDubs(10.1)
    await settle()
    expect(dubEl("a")?.paused).toBe(true)
  })

  it("the Target speaker button silences the dub without unloading it", async () => {
    // Muting is strictly element.muted — overlay lifecycle never depends on it,
    // so unmuting mid-line is positional rather than restarting the take.
    setQueueAudibility({ source: true, target: false })
    startExternalDubs(ctxFor([line("a", 10, 20, 8000)]))
    setExternalDubsPlaying(true)
    tickExternalDubs(10.1)
    await settle()
    expect(dubEl("a")?.muted).toBe(true)
    expect(poolIds()).toEqual(["a"])
  })

  it("a line with no take never fires", async () => {
    startExternalDubs(ctxFor([line("a", 10, 12)]))
    setExternalDubsPlaying(true)
    tickExternalDubs(10.1)
    await settle()
    expect(poolIds()).toEqual([])
  })

  it("honours a moved take: the dub fires at the ANCHOR, not the line's start", async () => {
    // Round 4 made the anchor relative (target_offset_ms). A take nudged two
    // seconds later must sound two seconds later.
    const moved = {
      ...line("a", 10, 20, 4000),
      metadata: { target_offset_ms: 2000 },
    } as unknown as CellData
    startExternalDubs(ctxFor([moved]))
    setExternalDubsPlaying(true)
    tickExternalDubs(10.5)
    await settle()
    expect(poolIds()).toEqual([])

    tickExternalDubs(12.1)
    await settle()
    expect(poolIds()).toEqual(["a"])
  })

  it("picks up a take recorded mid-session without restarting playback", async () => {
    const before = [line("a", 10, 20)]
    startExternalDubs(ctxFor(before))
    setExternalDubsPlaying(true)
    tickExternalDubs(10.1)
    await settle()
    expect(poolIds()).toEqual([])

    updateExternalDubCells([line("a", 10, 20, 4000)])
    tickExternalDubs(10.35)
    await settle()
    expect(poolIds()).toEqual(["a"])
  })

  it("handing playback back tears every dub down", async () => {
    startExternalDubs(ctxFor([line("a", 10, 20, 8000)]))
    setExternalDubsPlaying(true)
    tickExternalDubs(10.1)
    await settle()
    const el = dubEl("a")

    stopExternalDubs()
    expect(poolIds()).toEqual([])
    expect(el?.paused).toBe(true)
    expect(getExternalDubsSnapshot().driving).toBe(false)
  })

  it("joins a take mid-clip when the master is past its anchor", async () => {
    // The control for the case below: with a known length, the offset is real.
    startExternalDubs(ctxFor([line("a", 10, 20, 8000)]))
    setExternalDubsPlaying(true)
    tickExternalDubs(11)
    await settle()
    const el = dubEl("a")
    expect(el?.seekLog.length).toBeGreaterThan(0)
    expect(el?.currentTime).toBeCloseTo(1, 1)
  })

  it("does NOT seek a clip whose length is unknown — it would end the take", async () => {
    // A recorded take is a MediaRecorder webm, and that container carries no
    // duration: `duration` reads Infinity until the whole clip is indexed.
    // Seeking one makes Chrome settle the duration to however much it has
    // indexed (a fraction of a second), land past that, and fire `ended`
    // immediately — the take is thrown away unheard. Measured against a real
    // take over a linked picture, 2026-08-12; roughly one play in three.
    FakeAudio.duration = Infinity
    startExternalDubs(ctxFor([line("a", 10, 20, 8000)]))
    setExternalDubsPlaying(true)
    tickExternalDubs(11)
    await settle()
    const el = dubEl("a")
    expect(el?.paused).toBe(false)
    expect(el?.seekLog).toEqual([])
    expect(el?.currentTime).toBe(0)
  })

  it("ticks are ignored once the picture has handed back", async () => {
    startExternalDubs(ctxFor([line("a", 10, 20, 8000)]))
    stopExternalDubs()
    tickExternalDubs(10.1)
    await settle()
    expect(poolIds()).toEqual([])
  })
})
