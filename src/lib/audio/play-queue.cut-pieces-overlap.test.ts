// AQU-2432 (review, Nov 9): following the source, a piece of a cut take dragged
// over the end of the piece before it plays from its own start while the
// earlier piece rings on — under a film and under an imported source recording.
// Before, the later piece waited for the earlier one to end and came in already
// partway through (its first words never heard); under a source recording its
// arm was dropped and it might not play at all.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("./upload", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  probeCellAudioPresent: async () => "unknown",
  getCellAudioStreamUrl: async () => null,
}))
vi.mock("./bytes-cache", () => ({
  audioCacheGet: async () => null,
  audioCachePut: async () => undefined,
}))

import {
  getDubDebugSnapshot,
  overlayKey,
  overlayPieceKey,
  planTargetOverlay,
  planUpcomingDubs,
  setExternalDubsPlaying,
  setQueueAudibility,
  setQueueTimingMode,
  startExternalDubs,
  startQueue,
  stopExternalDubs,
  stopQueue,
  tickExternalDubs,
  type PlayContext,
} from "./play-queue"
import type { CellData } from "@/hooks/useCells"

class FakeAudio {
  static instances: FakeAudio[] = []
  src: string
  paused = true
  muted = false
  volume = 1
  playbackRate = 1
  currentTime = 0
  duration = 30
  readyState = 4
  preload = ""
  error = null
  onended: null | (() => void) = null
  onerror: null | (() => void) = null
  ontimeupdate: null | (() => void) = null
  onloadedmetadata: null | (() => void) = null
  ondurationchange: null | (() => void) = null
  onpause: null | (() => void) = null
  onplay: null | (() => void) = null
  onplaying: null | (() => void) = null
  oncanplay: null | (() => void) = null
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
  addEventListener(): void {}
  removeEventListener(): void {}
  /** The master's timeupdate at `t`. */
  tick(t: number): void {
    this.currentTime = t
    this.ontimeupdate?.()
  }
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0))
}
const ctxFor = (cells: CellData[]): PlayContext => ({
  cells, projectId: "p1", session: { jwt: "t", username: "dev", createdAt: "" } as PlayContext["session"],
})

const A = "audio-a-1700000000-take.wav"
const B = "audio-a-1700000500-piece.wav"
const CLIP = "http://audio.test/clip.mp3"
const SOURCE_ID = "audio-f1-1690000000-shared.mp3"

/** Line at 10s–14s with its take cut at 1.5s (piece A 10–11.5s, piece B
 *  11.5–14s), and piece B then dragged half a second EARLIER: it starts at
 *  11.0s, under the last half second of piece A. */
function overlappedPieces(withSource = false): CellData {
  return {
    id: "a", fileId: "f1", original: "", translated: "",
    medium: withSource ? "media" : "text", startTime: 10, endTime: 14,
    selectedAudioId: A,
    attachments: {
      [A]: { type: "audio", url: "http://audio.test/a.wav", slot: "recording", durationMs: 4000, trimEndMs: 1500 },
      [B]: { type: "audio", url: "http://audio.test/a.wav", slot: "recording", durationMs: 4000, trimStartMs: 1500, pieceOf: A, targetOffsetMs: -500 },
      ...(withSource ? { [SOURCE_ID]: { type: "audio", url: CLIP } } : {}),
    },
  } as unknown as CellData
}

const pooled = () => getDubDebugSnapshot().pool.map((e) => e.audioId).sort()

beforeEach(() => {
  FakeAudio.instances = []
  vi.stubGlobal("Audio", FakeAudio)
  setQueueAudibility({ source: true, target: true })
})
afterEach(() => {
  stopExternalDubs()
  stopQueue()
  setQueueTimingMode("dubbing")
  vi.unstubAllGlobals()
})

describe("planTargetOverlay with a piece dragged over the piece before it", () => {
  const ringingA = new Set([overlayKey("a", "recording"), overlayPieceKey("a", "recording", A)])

  it("fires the later piece at ITS start, from its first word, while the earlier one rings", () => {
    const plan = planTargetOverlay([overlappedPieces()], 0, ringingA, "advance", 11.0, { masterIsExternal: true })
    expect(plan.kind).toBe("fire")
    if (plan.kind !== "fire") return
    expect(plan.audioId).toBe(B)
    expect(plan.startAtClipSec).toBeCloseTo(1.5)
  })

  it("keeps the later piece armed while the earlier one plays, before the overlap", () => {
    const plan = planTargetOverlay([overlappedPieces()], 0, ringingA, "advance", 10.5, { masterIsExternal: true })
    expect(plan).toMatchObject({ kind: "arm", dueSec: 11, overlay: "keep" })
  })

  it("keeps both once both sound", () => {
    const both = new Set([...ringingA, overlayPieceKey("a", "recording", B)])
    expect(planTargetOverlay([overlappedPieces()], 0, both, "advance", 11.2, { masterIsExternal: true }).kind).toBe("keep")
  })

  it("makes ready the later PIECE for its own start, not the earlier one over again", () => {
    // Before the line: the first piece is next. While it plays: the second, at its own start.
    expect(planUpcomingDubs([overlappedPieces()], 9, { masterIsExternal: true }).map((n) => [n.audioId, n.dueSec, n.startAtClipSec]))
      .toEqual([[A, 10, 0]])
    expect(planUpcomingDubs([overlappedPieces()], 10.2, { masterIsExternal: true }).map((n) => [n.audioId, n.dueSec, n.startAtClipSec]))
      .toEqual([[B, 11, 1.5]])
    // Inside the overlap both sound: nothing of this line is still to come.
    expect(planUpcomingDubs([overlappedPieces()], 11.2, { masterIsExternal: true })).toEqual([])
  })
})

describe("under a film", () => {
  it("plays both pieces through the overlap, the later one from its start", async () => {
    startExternalDubs(ctxFor([overlappedPieces()]))
    setExternalDubsPlaying(true)
    tickExternalDubs(10.02)
    await settle()
    expect(pooled()).toEqual([A])
    tickExternalDubs(11.02)
    await settle()
    expect(pooled()).toEqual([A, B])
    const b = getDubDebugSnapshot().pool.find((e) => e.audioId === B)!
    expect(b.clipSec).toBeCloseTo(1.52, 1)
  })
})

describe("under an imported source recording", () => {
  const master = () => FakeAudio.instances.find((a) => a.src === CLIP)!

  it("plays both pieces through the overlap, the later one from its start", async () => {
    startQueue(ctxFor([overlappedPieces(true)]), 0)
    await settle()
    master().tick(10.02)
    await settle()
    expect(pooled()).toEqual([A])
    master().tick(10.5) // another track's arm, a re-flow: any plan made while A plays
    await settle()
    master().tick(11.02)
    await settle()
    expect(pooled()).toEqual([A, B])
    master().tick(11.3)
    await settle()
    expect(pooled()).toEqual([A, B])
  })
})
