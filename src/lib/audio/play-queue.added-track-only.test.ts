// AQU-2495 (review, Nov 9): a chapter whose recordings are ALL on an added
// voice track (a dramatised book: the studio put its voices on added tracks,
// the main track has no take) is playable while the file follows its
// recordings — the transport lays those takes in and plays them. Play all,
// Space, next/previous line, Play all's run into the next chapter and a
// chapter picked while playing all asked `hasAnyPlayableAudio`, which looked
// only at the main track's chosen take and said no.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  getQueueState,
  hasAnyPlayableAudio,
  setQueueLayerTrackSlots,
  setQueueTargetSlots,
  setQueueTimingMode,
  startQueue,
  stopQueue,
  type PlayContext,
} from "./play-queue"
import { planChapterPick } from "@/lib/timeline/chapter-pick"
import type { TimelineChapter } from "@/lib/timeline/sequence-timeline"
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
  preload = ""
  error = null
  src: string
  onended: (() => void) | null = null
  onerror: (() => void) | null = null
  ontimeupdate: (() => void) | null = null
  onloadedmetadata: (() => void) | null = null
  oncanplay: (() => void) | null = null
  onplay: (() => void) | null = null
  onplaying: (() => void) | null = null
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
  addEventListener(type: string, fn: () => void): void {
    if (type === "canplay" || type === "seeked") queueMicrotask(() => fn())
  }
  removeEventListener(): void {}
}

const settle = async (): Promise<void> => {
  for (let r = 0; r < 3; r++) {
    for (let i = 0; i < 8; i++) await Promise.resolve()
    await new Promise((res) => setTimeout(res, 0))
  }
}

const TRACK = "trk-1"

/** A line of a book with no times; its only take, if any, is on Track 1. */
function line(id: string, trackTakeMs: number | null, over: Partial<CellData> = {}): CellData {
  const takeId = `audio-${id}-1700000500-voice.webm`
  return {
    id, fileId: "f1", original: `${id} words`, translated: "", medium: "text",
    ...(trackTakeMs != null ? { selectedBySlot: { [TRACK]: takeId } } : {}),
    attachments: trackTakeMs != null
      ? { [takeId]: { type: "audio", url: `http://audio.test/${id}-voice.webm`, slot: TRACK, durationMs: trackTakeMs } }
      : {},
    ...over,
  } as unknown as CellData
}

/** A line recorded on the main track. */
function mainLine(id: string): CellData {
  const takeId = `audio-${id}-1700000000-main.webm`
  return {
    id, fileId: "f1", original: `${id} words`, translated: "", medium: "text",
    selectedAudioId: takeId,
    attachments: { [takeId]: { type: "audio", url: `http://audio.test/${id}.webm`, slot: "recording", durationMs: 2000 } },
  } as unknown as CellData
}

const ctxFor = (cells: CellData[]): PlayContext => ({
  cells,
  projectId: "p1",
  session: { jwt: "t", username: "dev", createdAt: "" } as PlayContext["session"],
})

const RUTH_2 = () => [line("r2v1", 2000), line("r2v2", 3000)]

beforeEach(() => {
  FakeAudio.instances = []
  vi.stubGlobal("Audio", FakeAudio)
  setQueueTargetSlots(["recording", TRACK])
  setQueueLayerTrackSlots([])
  setQueueTimingMode("audioFirst")
})

afterEach(() => {
  stopQueue()
  setQueueTimingMode("dubbing")
  setQueueTargetSlots(["recording"])
  setQueueLayerTrackSlots([])
  vi.unstubAllGlobals()
})

describe("a chapter recorded only on an added track, following the recordings (AQU-2495)", () => {
  it("has something to play — the transport plays it", async () => {
    const cells = RUTH_2()
    expect(hasAnyPlayableAudio(cells)).toBe(true)
    startQueue(ctxFor(cells), 0)
    await settle()
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "r2v1" })
  })

  it("…and the same when the added track was made a layer", async () => {
    setQueueLayerTrackSlots([TRACK])
    const cells = RUTH_2()
    expect(hasAnyPlayableAudio(cells)).toBe(true)
    startQueue(ctxFor(cells), 0)
    await settle()
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "r2v1" })
  })

  it("answers for the tracks it is handed, whatever the queue holds (the play strip, before the queue is told)", () => {
    setQueueTimingMode("dubbing")
    setQueueTargetSlots(["recording"])
    const cells = RUTH_2()
    expect(hasAnyPlayableAudio(cells, { freeTiming: true, tracks: { layerSlots: [TRACK], layerTrackSlots: [] } })).toBe(true)
    expect(hasAnyPlayableAudio(cells, { freeTiming: false, tracks: { layerSlots: [TRACK], layerTrackSlots: [] } })).toBe(false)
  })

  it("a chapter picked while playing carries playback on into it", () => {
    const lines = [mainLine("r1v1"), ...RUTH_2()]
    const chapters: TimelineChapter[] = [
      { key: "RUT 1", cellIds: ["r1v1"] },
      { key: "RUT 2", cellIds: ["r2v1", "r2v2"] },
    ]
    expect(planChapterPick({ chapters, lines, pickedKey: "RUT 2", playingKey: "RUT 1", queueKind: "playing" }))
      .toEqual({ kind: "play", chapter: chapters[1] })
  })

  it("still nothing to play: no take on any track, a track that is gone, or only hidden lines", () => {
    expect(hasAnyPlayableAudio([line("a", null), line("b", null)])).toBe(false)
    // The track was deleted: its takes are not laid in, and would not sound.
    setQueueTargetSlots(["recording"])
    expect(hasAnyPlayableAudio(RUTH_2())).toBe(false)
    setQueueTargetSlots(["recording", TRACK])
    const hidden = RUTH_2().map((c) => ({ ...c, hidden: true }) as CellData)
    expect(hasAnyPlayableAudio(hidden)).toBe(false)
    startQueue(ctxFor(hidden), 0)
    expect(getQueueState().kind).toBe("idle")
  })

  it("following the source, the queue plays a line by its main take only — unchanged", async () => {
    setQueueTimingMode("dubbing")
    const cells = RUTH_2()
    expect(hasAnyPlayableAudio(cells)).toBe(false)
    startQueue(ctxFor(cells), 0)
    await settle()
    expect(getQueueState().kind).toBe("idle")
  })
})
