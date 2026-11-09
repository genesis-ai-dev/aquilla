// AQU-2495 (review, Nov 9): the missing-audio mark belongs to the TAKE whose
// file is gone. The registry held one entry per line and the timeline asked
// it by line, so a line with a main-track take whose file was gone and a
// healthy take on a voice track showed the red mark on both — and on every
// piece of a cut take on any track.

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
  getMissingClipTakes,
  resetMissingClipsForTests,
  setQueueLayerTrackSlots,
  setQueueTargetSlots,
  setQueueTimingMode,
  startQueue,
  stopQueue,
  updateQueueCells,
  type PlayContext,
} from "./play-queue"
import { missingTakeKey } from "./track-audio"
import { buildFrontierAudioUrl } from "./upload"

const GONE = () => Object.assign(new Error("audio not found (404): gone"), { status: 404 })
const CLIP = "http://audio.test/clip.mp3"
const SOURCE_ID = "audio-f1-1690000000-shared.mp3"
const TRACK = "trk-1"

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
}

const mainId = (id: string) => `audio-${id}-1700000000-take.webm`
const voiceId = (id: string) => `audio-${id}-1700000500-voice.webm`
const frontier = (audioId: string) => buildFrontierAudioUrl(audioId.replace(/\.webm$/, ""), "webm")

/**
 * A line of an imported recording (0–3 s … ) with a take on the main track
 * and one on a voice track. `gone` says whose file the server no longer has;
 * the other is a plain URL that plays.
 */
function line(id: string, startTime: number, gone: "main" | "voice", over: Partial<CellData> = {}): CellData {
  return {
    id, fileId: "f1", original: "", translated: "", medium: "media", startTime, endTime: startTime + 3,
    selectedAudioId: mainId(id),
    selectedBySlot: { [TRACK]: voiceId(id) },
    attachments: {
      [mainId(id)]: { type: "audio", slot: "recording", durationMs: 3000, url: gone === "main" ? frontier(mainId(id)) : `http://audio.test/${id}-main.webm` },
      [voiceId(id)]: { type: "audio", slot: TRACK, durationMs: 3000, url: gone === "voice" ? frontier(voiceId(id)) : `http://audio.test/${id}-voice.webm` },
      [SOURCE_ID]: { type: "audio", url: CLIP },
    },
    ...over,
  } as unknown as CellData
}

const ctxFor = (cells: CellData[]): PlayContext => ({
  cells,
  projectId: "p1",
  session: { jwt: "t", username: "dev", createdAt: "" } as PlayContext["session"],
})
const settle = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0))
}
const marked = (id: string, audioId: string) => getMissingClipTakes().has(missingTakeKey(id, audioId))

beforeEach(() => {
  FakeAudio.instances = []
  vi.stubGlobal("Audio", FakeAudio)
  ;(URL as unknown as Record<string, unknown>).createObjectURL ??= () => "blob:fake"
  ;(URL as unknown as Record<string, unknown>).revokeObjectURL ??= () => {}
  fetchCellAudio.mockReset()
  fetchCellAudio.mockRejectedValue(GONE())
  probePresent.mockReset()
  streamUrl.mockReset()
  streamUrl.mockResolvedValue(null) // force the throwing resolve path
  resetMissingClipsForTests()
  setQueueTargetSlots(["recording", TRACK])
  setQueueLayerTrackSlots([])
})
afterEach(() => {
  stopQueue()
  setQueueTimingMode("dubbing")
  setQueueTargetSlots(["recording"])
  setQueueLayerTrackSlots([])
  vi.unstubAllGlobals()
})

describe.each(["dubbing", "audioFirst"] as const)("a take whose file is gone, %s (AQU-2495)", (timing) => {
  beforeEach(() => setQueueTimingMode(timing))

  it("the main track's take is gone: only that take is marked, not the line's take on the voice track", async () => {
    const cells = [line("v1", 0, "main")]
    startQueue(ctxFor(cells), 0)
    await settle()
    expect(marked("v1", mainId("v1"))).toBe(true)
    expect(marked("v1", voiceId("v1"))).toBe(false)
    expect([...getMissingClipTakes()]).toEqual([missingTakeKey("v1", mainId("v1"))])
  })

  it("the voice track's take is gone: only that take is marked, and it stays marked", async () => {
    const cells = [line("v1", 0, "voice")]
    startQueue(ctxFor(cells), 0)
    await settle()
    expect(marked("v1", voiceId("v1"))).toBe(true)
    expect(marked("v1", mainId("v1"))).toBe(false)
    // The line's cells coming round again (any edit elsewhere) keeps the mark
    // on a take that is still the one its track plays.
    updateQueueCells(cells)
    expect(marked("v1", voiceId("v1"))).toBe(true)
  })

  it("the mark leaves with the take: another take chosen on that track clears it", async () => {
    const cells = [line("v1", 0, "voice")]
    startQueue(ctxFor(cells), 0)
    await settle()
    expect(marked("v1", voiceId("v1"))).toBe(true)
    const redoneId = "audio-v1-1700009999-voice.webm"
    const redone = [{
      ...cells[0],
      selectedBySlot: { [TRACK]: redoneId },
      attachments: { ...cells[0].attachments, [redoneId]: { type: "audio", slot: TRACK, durationMs: 3000, url: "http://audio.test/v1-redone.webm" } },
    } as unknown as CellData]
    updateQueueCells(redone)
    expect(getMissingClipTakes().size).toBe(0)
    expect(getMissingClipCells().has("v1")).toBe(false)
  })
})

describe("the pieces of a cut take share its file (AQU-2495)", () => {
  it("one piece found gone marks every piece of that take, and no other take of the line", async () => {
    setQueueTimingMode("dubbing")
    const p1 = mainId("v1")
    const p2 = "audio-v1-1700000001-piece.webm"
    const cut = line("v1", 0, "main")
    const cells = [{
      ...cut,
      attachments: {
        ...cut.attachments,
        [p1]: { ...cut.attachments![p1], trimEndMs: 1500 },
        [p2]: { ...cut.attachments![p1], pieceOf: p1, trimStartMs: 1500 },
      },
    } as unknown as CellData]
    startQueue(ctxFor(cells), 0)
    await settle()
    expect(marked("v1", p1)).toBe(true)
    expect(marked("v1", p2)).toBe(true)
    expect(marked("v1", voiceId("v1"))).toBe(false)
  })
})
