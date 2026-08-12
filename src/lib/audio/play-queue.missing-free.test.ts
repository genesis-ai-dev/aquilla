// Decision 2026-08-05 — free-timing missing-clip semantics. A definitively
// missing clip (the 404 sentinel / a "missing" probe verdict) surfaces
// "This clip's audio is missing." IMMEDIATELY on an explicit start and badges
// the line's chip via the registry; anything not definitively missing keeps
// the existing transient behavior (strike, carry, retry, 6s patience) byte
// for byte — a flaky network must never read as missing.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { CellData } from "@/hooks/useCells"

const fetchCellAudio = vi.fn()
const probePresent = vi.fn()
const streamUrl = vi.fn()
vi.mock("./upload", async () => {
  const actual = await vi.importActual<typeof import("./upload")>("./upload")
  return {
    ...actual,
    fetchCellAudio: (...args: unknown[]) => fetchCellAudio(...args),
    probeCellAudioPresent: (...args: unknown[]) => probePresent(...args),
    getCellAudioStreamUrl: (...args: unknown[]) => streamUrl(...args),
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
  getMissingClipCells,
  getQueueState,
  MISSING_AUDIO_MESSAGE,
  resetMissingClipsForTests,
  resumeQueue,
  setQueueTimingMode,
  startQueue,
  startQueueAtTime,
  stopQueue,
  type PlayContext,
  type QueueState,
} from "./play-queue"
import { buildFrontierAudioUrl } from "./upload"

const SENTINEL = () => Object.assign(new Error("audio not found (404): gone"), { status: 404 })
const CLIP = "http://audio.test/clip.mp3"
const SOURCE_ID = "audio-f1-1690000000-shared.mp3"

/** Minimal fake element: ready by default, tickable, failable. */
class FakeAudio {
  static instances: FakeAudio[] = []
  src: string
  paused = true
  ended = false
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
    // Ready elements report readiness synchronously via the gate's readyState
    // check, but a canplay/seeked listener added to a READY fake should fire.
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
  failLoad(): void {
    this.onerror?.()
    this.emit("error")
  }
}

/** A verse whose DUB is a frontier clip (resolvable/failable via the mocks). */
function verseFrontierDub(id: string, startTime: number, endTime: number, opts: { source?: boolean } = {}): CellData {
  const takeId = `audio-${id}-1700000000-take`
  return {
    id,
    fileId: "f1",
    original: "",
    translated: "",
    medium: "media",
    startTime,
    endTime,
    selectedAudioId: `${takeId}.webm`,
    attachments: {
      [`${takeId}.webm`]: { type: "audio", url: buildFrontierAudioUrl(takeId, "webm"), durationMs: 3000 },
      ...(opts.source !== false ? { [SOURCE_ID]: { type: "audio", url: CLIP } } : {}),
    },
  } as unknown as CellData
}

/** A source-only verse (no dub). */
function verseSourceOnly(id: string, startTime: number, endTime: number): CellData {
  return {
    id, fileId: "f1", original: "", translated: "", medium: "media", startTime, endTime,
    attachments: { [SOURCE_ID]: { type: "audio", url: CLIP } },
  } as unknown as CellData
}

const ctxFor = (cells: CellData[]): PlayContext => ({
  cells,
  projectId: "p1",
  session: { jwt: "t", username: "dev", createdAt: "" } as PlayContext["session"],
})

const sourceEl = (): FakeAudio | undefined =>
  [...FakeAudio.instances].reverse().find((a) => a.src === CLIP)
const settle = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0))
}

describe("free-timing missing clips (2026-08-05)", () => {
  beforeEach(() => {
    FakeAudio.instances = []
    vi.stubGlobal("Audio", FakeAudio)
    ;(URL as unknown as Record<string, unknown>).createObjectURL ??= () => "blob:fake"
    ;(URL as unknown as Record<string, unknown>).revokeObjectURL ??= () => {}
    fetchCellAudio.mockReset()
    probePresent.mockReset()
    streamUrl.mockReset()
    streamUrl.mockResolvedValue(null) // default: force the throwing resolve path
    resetMissingClipsForTests()
    setQueueTimingMode("audioFirst")
  })
  afterEach(() => {
    stopQueue()
    setQueueTimingMode("dubbing")
    vi.unstubAllGlobals()
  })

  it("explicit start on a dub-only verse with MISSING audio surfaces the message immediately", async () => {
    fetchCellAudio.mockRejectedValue(SENTINEL())
    const cells = [verseFrontierDub("v1", 0, 3, { source: false })]
    startQueue(ctxFor(cells), 0, /* explicit */ true)
    await settle()
    // No timers advanced — the sentinel classifies synchronously, no 6s wait.
    const state = getQueueState()
    expect(state).toMatchObject({ kind: "error", message: MISSING_AUDIO_MESSAGE, cellId: "v1" })
    expect(getMissingClipCells().has("v1")).toBe(true)
  })

  it("missing dub + healthy source: the verse plays the original alone, badged, never the raw sentinel", async () => {
    fetchCellAudio.mockRejectedValue(SENTINEL())
    const observed: QueueState[] = []
    const cells = [verseFrontierDub("v1", 0, 3)]
    startQueue(ctxFor(cells), 0, true)
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 0))
      observed.push(getQueueState())
    }
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "v1" })
    expect(sourceEl()!.paused).toBe(false)
    expect(getMissingClipCells().has("v1")).toBe(true)
    for (const s of observed) {
      expect(s.kind === "error" ? s.message : "").not.toContain("audio not found")
    }
  })

  it("play after CLICKING a verse whose dub is missing surfaces it — the paused cue keeps the explicit flag (2026-08-06)", async () => {
    fetchCellAudio.mockRejectedValue(SENTINEL())
    const cells = [verseFrontierDub("v1", 0, 3, { source: false }), verseSourceOnly("v2", 3, 6)]
    // Click-a-verse while nothing plays = an explicit PAUSED cue (no gate) —
    // the resolve fails quietly while paused, which is correct.
    startQueueAtTime(ctxFor(cells), 0, { play: false })
    await settle()
    expect(getQueueState()).toMatchObject({ kind: "paused" })
    // Press Play: the re-entry must keep the user's choice — the verse THEY
    // picked surfaces its missing dub (AQU-660 parity) instead of the
    // transport silently sliding on to v2.
    await resumeQueue()
    await settle()
    expect(getQueueState()).toMatchObject({ kind: "error", message: MISSING_AUDIO_MESSAGE, cellId: "v1" })
    expect(getMissingClipCells().has("v1")).toBe(true)
  })

  it("auto-advance skips a missing dub-only verse (non-explicit) and still badges it", async () => {
    fetchCellAudio.mockRejectedValue(SENTINEL())
    const cells = [
      verseSourceOnly("v1", 0, 2),
      verseFrontierDub("v2", 2, 5, { source: false }),
      verseSourceOnly("v3", 5, 8),
    ]
    startQueue(ctxFor(cells), 0, /* explicit */ false)
    await settle()
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "v1" })
    sourceEl()!.tick(2) // v1's window ends → advance into the dead v2
    await settle()
    // v2's dub is missing and nothing else can sound there → skipped to v3.
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "v3" })
    expect(getMissingClipCells().has("v2")).toBe(true)
  })

  it("an element error with a probe verdict of 'unknown' is NOT marked missing", async () => {
    // The dub resolves via a streaming URL (minted blind), then errors with no
    // status — only the probe can classify, and "unknown" must stay transient.
    streamUrl.mockResolvedValue("https://stream.test/v1-take.webm?t=tok")
    probePresent.mockResolvedValue("unknown")
    const cells = [verseFrontierDub("v1", 0, 3)]
    startQueue(ctxFor(cells), 0, true)
    await settle()
    const dub = FakeAudio.instances.find((a) => a.src.includes("stream.test"))
    expect(dub).toBeDefined()
    dub!.failLoad()
    await settle()
    expect(getMissingClipCells().has("v1")).toBe(false)
    // …while a definitive 'missing' verdict on the same path DOES mark
    // (fresh attempt — the struck entry's handlers are gone with it).
    probePresent.mockResolvedValue("missing")
    stopQueue()
    startQueue(ctxFor(cells), 0, true)
    await settle()
    const dub2 = [...FakeAudio.instances].reverse().find((a) => a.src.includes("stream.test"))
    expect(dub2).toBeDefined()
    dub2!.failLoad()
    await settle()
    expect(getMissingClipCells().has("v1")).toBe(true)
  })

  it("a missing SOURCE with a healthy dub lets the dub carry — no error state, no badge", async () => {
    // Source is a frontier clip that 404s; the dub is a direct URL and fine.
    const takeId = "audio-v1-1700000000-take"
    const cells = [
      {
        id: "v1", fileId: "f1", original: "", translated: "", medium: "media",
        startTime: 0, endTime: 3,
        selectedAudioId: `${takeId}.webm`,
        attachments: {
          [`${takeId}.webm`]: { type: "audio", url: "http://audio.test/v1.webm", durationMs: 3000 },
          [SOURCE_ID]: { type: "audio", url: buildFrontierAudioUrl("audio-f1-1690000000-shared", "mp3") },
        },
      } as unknown as CellData,
    ]
    fetchCellAudio.mockRejectedValue(SENTINEL())
    startQueue(ctxFor(cells), 0, true)
    await settle()
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "v1" })
    expect(getMissingClipCells().has("v1")).toBe(false)
  })
})
