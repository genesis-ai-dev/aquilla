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
  startQueueAtTime,
  stopQueue,
  updateQueueCells,
  type PlayContext,
} from "./play-queue"
import type { CellData } from "@/hooks/useCells"

const CLIP = "http://audio.test/imported.mp3" // direct URL → no token/network path

class FakeAudio {
  static instances: FakeAudio[] = []
  /** Readiness gate tests: sources matching this predicate construct UNREADY
   *  (readyState 0, no metadata, play() held) until `makeReady()` is called —
   *  a clip still crossing the network. Default: everything ready instantly. */
  static deferSrc: (src: string) => boolean = () => false
  currentTime = 0
  duration = 600
  paused = true
  ended = false
  muted = false
  volume = 1
  playbackRate = 1
  /** HAVE_ENOUGH_DATA by default; 0 while deferred. */
  readyState = 4
  src: string
  onended: (() => void) | null = null
  onerror: (() => void) | null = null
  ontimeupdate: (() => void) | null = null
  onloadedmetadata: (() => void) | null = null
  oncanplay: (() => void) | null = null
  onplay: (() => void) | null = null
  onpause: (() => void) | null = null
  /** play() promises issued while unready — resolved by makeReady(). */
  private pendingPlays: (() => void)[] = []
  private deferred: boolean
  constructor(src: string) {
    this.src = src
    this.deferred = FakeAudio.deferSrc(src)
    if (this.deferred) this.readyState = 0
    FakeAudio.instances.push(this)
    // A real element announces metadata shortly after the src is set, which is
    // when the queue applies a pending seek (Safari rejects earlier ones).
    if (!this.deferred) queueMicrotask(() => this.onloadedmetadata?.())
  }
  async play(): Promise<void> {
    if (this.deferred) {
      // A real element's play() during buffering resolves once playback can
      // begin — hold it, like the network would.
      await new Promise<void>((res) => this.pendingPlays.push(res))
    }
    this.paused = false
    this.onplay?.()
  }
  pause(): void {
    if (this.paused) return
    this.paused = true
    this.onpause?.()
  }
  /** The deferred clip's bytes arrived: fire metadata + canplay, release
   *  held play() calls. */
  makeReady(): void {
    if (!this.deferred) return
    this.deferred = false
    this.readyState = 4
    this.onloadedmetadata?.()
    this.oncanplay?.()
    this.emit("canplay")
    const held = this.pendingPlays.splice(0)
    for (const res of held) res()
  }
  /** Simulate a network/decode failure for a deferred clip. */
  failLoad(): void {
    this.deferred = false
    this.pendingPlays.splice(0) // held play() promises just never resolve play
    this.onerror?.()
    this.emit("error")
  }
  /** Drive a timeupdate tick, the way a real element would ~4×/second. */
  tick(t: number): void {
    this.currentTime = t
    this.ontimeupdate?.()
  }
  // Listener support for the gate's source-readiness watch (canplay/seeked/
  // error). makeReady/failLoad fire these alongside the on* fields.
  private listeners = new Map<string, Set<() => void>>()
  addEventListener(type: string, fn: () => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type)!.add(fn)
    // Matches real elements closely enough for the gate: a ready element
    // fires canplay-class listeners immediately after subscription in our
    // fake (the gate checks readyState first, so this is rarely reached).
    if (!this.deferred && (type === "canplay" || type === "seeked")) queueMicrotask(() => this.emit(type))
  }
  removeEventListener(type: string, fn: () => void): void {
    this.listeners.get(type)?.delete(fn)
  }
  private emit(type: string): void {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn()
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
  FakeAudio.deferSrc = () => false
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

// ── The readiness gate (smooth-playback round) ──────────────────────────────
// A verse's audio starts only when every DUE side is ready: until then the
// state says "loading" and the clock PARKS at the boundary (the fix for the
// PR-#229 "jumpy" rejection — the old flow reported "playing" while the dub
// still resolved, so the playhead ran ahead and snapped back, and the source
// started without its partner).

describe("audio-first readiness gate", () => {
  const dubDeferred = (id: string) => (src: string) => src.includes(`/${id}.webm`)

  it("a cold verse parks the clock as 'loading', then starts BOTH sides together", async () => {
    const cells = [verse("v1", 0, 3), verse("v2", 3, 7, 5_000)]
    FakeAudio.deferSrc = dubDeferred("v2")
    setQueueTimingMode("audioFirst")
    startQueue(ctxFor(cells), 0)
    await settle()
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "v1" })

    // v1's original runs out → the boundary. v2's dub is still "loading".
    sourceEl()!.tick(3)
    await settle()
    expect(getQueueState()).toMatchObject({ kind: "loading", cellId: "v2" })
    // The clock is PARKED at the verse top — no run-ahead to snap back from.
    expect(getQueueProgress().currentTime).toBe(3)
    // The source is HELD, not started without its partner.
    expect(sourceEl()!.paused).toBe(true)
    expect(dubEl("v2")!.paused).toBe(true)

    // Bytes arrive → the gate opens → both sides start as one.
    dubEl("v2")!.makeReady()
    await settle()
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "v2" })
    expect(sourceEl()!.paused).toBe(false)
    expect(dubEl("v2")!.paused).toBe(false)
    expect(getQueueProgress().currentTime).toBe(3)
  })

  it("pause during a gate cancels the pending start; resume re-arms it", async () => {
    const cells = [verse("v1", 0, 3), verse("v2", 3, 7, 5_000)]
    FakeAudio.deferSrc = dubDeferred("v2")
    setQueueTimingMode("audioFirst")
    startQueue(ctxFor(cells), 0)
    await settle()
    sourceEl()!.tick(3)
    await settle()
    expect(getQueueState().kind).toBe("loading")

    pauseQueue()
    expect(getQueueState().kind).toBe("paused")
    dubEl("v2")!.makeReady()
    await settle()
    // The gate opened while paused: everything cued at the verse top, silent.
    expect(getQueueState().kind).toBe("paused")
    expect(sourceEl()!.paused).toBe(true)
    expect(dubEl("v2")!.paused).toBe(true)

    await resumeQueue()
    expect(getQueueState().kind).toBe("playing")
    expect(dubEl("v2")!.paused).toBe(false)
  })

  it("resume during a still-pending gate stays 'loading' (nothing to play yet)", async () => {
    const cells = [verse("v1", 0, 3), verse("v2", 3, 7, 5_000)]
    FakeAudio.deferSrc = dubDeferred("v2")
    setQueueTimingMode("audioFirst")
    startQueue(ctxFor(cells), 0)
    await settle()
    sourceEl()!.tick(3)
    await settle()

    pauseQueue()
    await resumeQueue()
    expect(getQueueState().kind).toBe("loading")
    dubEl("v2")!.makeReady()
    await settle()
    expect(getQueueState().kind).toBe("playing")
  })

  it("a dub that FAILS to load opens the gate with the original alone", async () => {
    const cells = [verse("v1", 0, 3), verse("v2", 3, 7, 5_000)]
    FakeAudio.deferSrc = dubDeferred("v2")
    setQueueTimingMode("audioFirst")
    startQueue(ctxFor(cells), 0)
    await settle()
    sourceEl()!.tick(3)
    await settle()
    expect(getQueueState().kind).toBe("loading")

    dubEl("v2")!.failLoad()
    await settle()
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "v2" })
    expect(sourceEl()!.paused).toBe(false)
  })

  it("a gate that outlasts its patience starts what's ready", async () => {
    vi.useFakeTimers()
    try {
      const cells = [verse("v1", 0, 3), verse("v2", 3, 7, 5_000)]
      FakeAudio.deferSrc = dubDeferred("v2")
      setQueueTimingMode("audioFirst")
      startQueue(ctxFor(cells), 0)
      await vi.advanceTimersByTimeAsync(0)
      sourceEl()!.tick(3)
      await vi.advanceTimersByTimeAsync(0)
      expect(getQueueState().kind).toBe("loading")

      await vi.advanceTimersByTimeAsync(6_100)
      expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "v2" })
      expect(sourceEl()!.paused).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it("seeking away orphans a pending gate — the landing verse plays, the old one never fires", async () => {
    const cells = [verse("v1", 0, 3), verse("v2", 3, 7, 5_000), verse("v3", 7, 10, 2_000)]
    FakeAudio.deferSrc = dubDeferred("v2")
    setQueueTimingMode("audioFirst")
    startQueue(ctxFor(cells), 0)
    await settle()
    sourceEl()!.tick(3)
    await settle()
    expect(getQueueState().kind).toBe("loading")
    const orphaned = dubEl("v2")!

    // Seek into v3 (programme second 8.5 = 1.5s into v3's slot at 7… v1=3s,
    // v2=max(4,5)=5s → v3 starts at 8).
    seekQueueToTime(8.5)
    await settle()
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "v3" })

    // The orphaned dub coming ready must not touch the transport.
    orphaned.makeReady()
    await settle()
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "v3" })
  })

  it("a dub that DIES mid-verse leaves the original to carry the rest", async () => {
    // v1: original 6s, dub 11s → the dub clocks the verse.
    const cells = [verse("v1", 0, 6, 11_000), verse("v2", 6, 9, 2_000)]
    setQueueTimingMode("audioFirst")
    startQueue(ctxFor(cells), 0)
    await settle()
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "v1" })

    // 2s in, the dub's stream dies. The original still has 4s of this verse.
    sourceEl()!.tick(2)
    dubEl("v1")!.tick(2)
    dubEl("v1")!.failLoad()
    await settle()
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "v1" })

    // …and the original's window end now advances the verse (clock fell back).
    sourceEl()!.tick(6)
    await settle()
    expect(getQueueState()).toMatchObject({ cellId: "v2" })
  })

  it("a MUTED dub still gates the start — positional unmute depends on it", async () => {
    const { setQueueAudibility } = await import("./play-queue")
    setQueueAudibility({ source: true, target: false })
    try {
      const cells = [verse("v1", 0, 3), verse("v2", 3, 7, 5_000)]
      FakeAudio.deferSrc = dubDeferred("v2")
      setQueueTimingMode("audioFirst")
      startQueue(ctxFor(cells), 0)
      await settle()
      sourceEl()!.tick(3)
      await settle()
      // Muted or not, the verse waits for its dub so both start aligned.
      expect(getQueueState().kind).toBe("loading")
      dubEl("v2")!.makeReady()
      await settle()
      expect(getQueueState().kind).toBe("playing")
      expect(dubEl("v2")!.muted).toBe(true)
      expect(dubEl("v2")!.paused).toBe(false)
    } finally {
      setQueueAudibility({ source: true, target: true })
    }
  })

  it("skipForward during a gate lands cleanly on the next verse", async () => {
    const cells = [verse("v1", 0, 3), verse("v2", 3, 7, 5_000), verse("v3", 7, 10, 2_000)]
    FakeAudio.deferSrc = dubDeferred("v2")
    setQueueTimingMode("audioFirst")
    startQueue(ctxFor(cells), 0)
    await settle()
    sourceEl()!.tick(3)
    await settle()
    expect(getQueueState().kind).toBe("loading")

    skipForward()
    await settle()
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "v3" })
  })

  it("a dub-only verse gates and then reports 'playing' on its own", async () => {
    const takeId = "audio-v1-1700000000-take.webm"
    const dubOnly = {
      id: "v1", fileId: "f1", medium: "media", startTime: 0, endTime: 4,
      selectedAudioId: takeId,
      attachments: { [takeId]: { type: "audio", url: "http://audio.test/v1.webm", durationMs: 5_000 } },
    } as unknown as CellData
    FakeAudio.deferSrc = dubDeferred("v1")
    setQueueTimingMode("audioFirst")
    startQueue(ctxFor([dubOnly]), 0)
    await settle()
    expect(getQueueState().kind).toBe("loading")

    dubEl("v1")!.makeReady()
    await settle()
    // No source onplay exists to flip the state — the gate must do it itself.
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "v1" })
    expect(dubEl("v1")!.paused).toBe(false)
  })
})

// ── Fortify round: live-truth boundaries + transport hardening ──────────────
// Regression net for the adversarial-sweep findings: the programme (not
// values frozen into pool entries) is the ONE authority for verse boundaries,
// so mid-playback edits — trims, deleted takes, deleted verses — act on the
// truth; and the transport can never wedge in a silent "playing".

describe("audio-first fortify — live edits during playback", () => {
  it("trimming the PLAYING verse's dub applies immediately — no ghost tail, advance at the new end", async () => {
    // v1: original 4s, dub 12s (dub clocks). Trim the dub to 6s at t≈5.
    const cells = [verse("v1", 0, 4, 12_000), verse("v2", 4, 8, 3_000)]
    setQueueTimingMode("audioFirst")
    startQueue(ctxFor(cells), 0)
    await settle()
    sourceEl()!.tick(4) // original done; dub-solo tail
    dubEl("v1")!.tick(5)
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "v1" })

    const trimmed = [verse("v1", 0, 4, 12_000), verse("v2", 4, 8, 3_000)]
    const att = trimmed[0].attachments!["audio-v1-1700000000-take.webm"] as Record<string, number>
    att.trimEndMs = 6_000
    updateQueueCells(trimmed)

    // The next tick past the LIVE end (6s) must end the verse — the frozen
    // cue-time stop (12s) is no longer consulted.
    dubEl("v1")!.tick(6.1)
    await settle()
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "v2" })
  })

  it("deleting the PLAYING take silences it and moves on instead of wedging", async () => {
    const cells = [verse("v1", 0, 4, 12_000), verse("v2", 4, 8, 3_000)]
    setQueueTimingMode("audioFirst")
    startQueue(ctxFor(cells), 0)
    await settle()
    sourceEl()!.tick(4) // dub-solo tail — nothing else can carry the verse
    dubEl("v1")!.tick(5)

    const deleted = [verse("v1", 0, 4, 12_000), verse("v2", 4, 8, 3_000)]
    const att = deleted[0].attachments!["audio-v1-1700000000-take.webm"] as Record<string, unknown>
    att.isDeleted = true
    updateQueueCells(deleted)
    await settle()

    // The removed dub was the only sounding side → transport moved to v2
    // rather than sitting in silent "playing" forever.
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "v2" })
    expect(dubEl("v2")!.paused).toBe(false)
  })

  it("deleting the PLAYING VERSE re-enters at the next surviving verse", async () => {
    const cells = [verse("v1", 0, 4, 5_000), verse("v2", 4, 8, 3_000)]
    setQueueTimingMode("audioFirst")
    startQueue(ctxFor(cells), 0)
    await settle()
    expect(getQueueState()).toMatchObject({ cellId: "v1" })

    updateQueueCells([verse("v2", 4, 8, 3_000)]) // v1 gone entirely
    await settle()
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "v2" })
  })

  it("deleting the LAST verse while it plays finishes cleanly (no dead-end 'playing')", async () => {
    const cells = [verse("v1", 0, 4, 5_000)]
    setQueueTimingMode("audioFirst")
    startQueue(ctxFor(cells), 0)
    await settle()
    updateQueueCells([])
    await settle()
    expect(getQueueState().kind).toBe("idle")
  })
})

describe("audio-first fortify — transport can never wedge", () => {
  const dubDeferred = (id: string) => (src: string) => src.includes(`/${id}.webm`)

  it("cue-paused verse resumed BEFORE the dub resolves parks as 'loading', then starts both", async () => {
    const cells = [verse("v1", 0, 3, 8_000)]
    FakeAudio.deferSrc = dubDeferred("v1")
    setQueueTimingMode("audioFirst")
    // Cue paused at the verse (no gate on this path — but the cue DID create
    // the dub element, cold), then resume immediately.
    startQueueAtTime(ctxFor(cells), 0.5, { play: false })
    await settle()
    expect(getQueueState().kind).toBe("paused")
    await resumeQueue()
    await settle()
    // The dub element exists but is UNREADY — resume must not report
    // "playing" with a clock that can't tick (the playhead would extrapolate
    // ahead and snap back on the first real tick). It re-enters the gate.
    expect(getQueueState().kind).toBe("loading")
    dubEl("v1")?.makeReady()
    await settle()
    expect(getQueueState().kind).toBe("playing")
    expect(dubEl("v1")!.paused).toBe(false)
  })

  it("the gate's patience timer is SUSPENDED while paused — the dub survives a long pause", async () => {
    vi.useFakeTimers()
    try {
      const cells = [verse("v1", 0, 3), verse("v2", 3, 7, 5_000)]
      FakeAudio.deferSrc = dubDeferred("v2")
      setQueueTimingMode("audioFirst")
      startQueue(ctxFor(cells), 0)
      await vi.advanceTimersByTimeAsync(0)
      sourceEl()!.tick(3)
      await vi.advanceTimersByTimeAsync(0)
      expect(getQueueState().kind).toBe("loading")

      pauseQueue() // user answers the door…
      await vi.advanceTimersByTimeAsync(30_000) // …for 30 seconds
      // The dub was NOT struck while nobody was listening.
      expect(dubEl("v2")).toBeDefined()

      await resumeQueue()
      expect(getQueueState().kind).toBe("loading")
      dubEl("v2")!.makeReady()
      await vi.advanceTimersByTimeAsync(0)
      expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "v2" })
      expect(dubEl("v2")!.paused).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it("resume after the only side died RETRIES it gated, then advances when the retry dies too", async () => {
    vi.useFakeTimers()
    try {
      // Dub-only verse whose dub load fails while paused.
      const takeId = "audio-v1-1700000000-take.webm"
      const dubOnly = {
        id: "v1", fileId: "f1", medium: "media", startTime: 0, endTime: 4,
        selectedAudioId: takeId,
        attachments: { [takeId]: { type: "audio", url: "http://audio.test/v1.webm", durationMs: 5_000 } },
      } as unknown as CellData
      const cells = [dubOnly, verse("v2", 4, 8, 3_000)]
      FakeAudio.deferSrc = dubDeferred("v1")
      setQueueTimingMode("audioFirst")
      startQueue(ctxFor(cells), 0)
      await vi.advanceTimersByTimeAsync(0)
      expect(getQueueState().kind).toBe("loading")

      pauseQueue()
      dubEl("v1")!.failLoad() // the only side of the verse dies while paused
      await vi.advanceTimersByTimeAsync(0)
      await resumeQueue()
      await vi.advanceTimersByTimeAsync(0)
      // Resume re-enters through progPlaySlot: the dead dub is RE-CUED (a
      // user-driven retry with the gate's bounded patience) instead of the
      // verse being skipped on a possibly-transient failure. Honest state.
      expect(getQueueState()).toMatchObject({ kind: "loading", cellId: "v1" })

      // The retry dies too — NOW the verse has nothing left and we advance.
      dubEl("v1")!.failLoad()
      await vi.advanceTimersByTimeAsync(0)
      expect(getQueueState()).toMatchObject({ cellId: "v2" })
    } finally {
      vi.useRealTimers()
    }
  })

  it("seeking past the programme end lands at the END, not a full last-verse replay", async () => {
    const cells = [verse("v1", 0, 3, 2_000), verse("v2", 3, 7, 3_000)]
    setQueueTimingMode("audioFirst")
    startQueue(ctxFor(cells), 0)
    await settle()
    seekQueueToTime(999)
    await settle()
    // The bug was replaying v2 from its TOP (programme second 3). Landing at
    // the final moment may legitimately play the verse's last instant — what
    // must never happen is a rewind to the verse start.
    expect(getQueueProgress().currentTime).toBeGreaterThan(6.9)
  })
})

describe("audio-first fortify — plain content falls back to the dubbing path", () => {
  it("a TEXT cell in an audioFirst project still plays (single-line play button)", async () => {
    const textCell = {
      id: "t1", fileId: "f1", medium: "text",
      selectedGeneratedVoiceAudioId: "gen-1",
      attachments: { "gen-1": { type: "audio", url: "http://audio.test/gen-1.wav" } },
    } as unknown as CellData
    setQueueTimingMode("audioFirst")
    startQueue({ ...ctxFor([textCell]), snapshot: true }, 0)
    await settle()
    // The empty programme fell through to the plain path — audio plays.
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "t1" })
  })

  it("a snapshot context survives updateQueueCells — single-line play never marches on", async () => {
    const textCell = {
      id: "t1", fileId: "f1", medium: "text",
      selectedGeneratedVoiceAudioId: "gen-1",
      attachments: { "gen-1": { type: "audio", url: "http://audio.test/gen-1.wav" } },
    } as unknown as CellData
    const fullFile = [
      textCell,
      { id: "t2", fileId: "f1", medium: "text", selectedGeneratedVoiceAudioId: "gen-2",
        attachments: { "gen-2": { type: "audio", url: "http://audio.test/gen-2.wav" } } } as unknown as CellData,
    ]
    setQueueTimingMode("dubbing")
    startQueue({ ...ctxFor([textCell]), snapshot: true }, 0)
    await settle()
    updateQueueCells(fullFile) // the bar's keep-fresh effect fires
    // The one-cell snapshot was NOT clobbered: ending the clip ends playback.
    const el = [...FakeAudio.instances].reverse().find((a) => a.src.includes("gen-1"))!
    el.ended = true
    el.onended?.()
    await settle()
    expect(getQueueState().kind).toBe("idle")
  })
})
