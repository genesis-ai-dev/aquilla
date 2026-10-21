// AQU-1767 follow-up: the next LINE's take is made ready while the one before
// it plays, and fired at its start. A line's player used to be made when the
// line came due — in Safari's engine every line then started about a tenth of
// a second behind its waveform — and was told to play on the clock's next tick
// rather than at its start.
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
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const ctxFor = (cells: CellData[]): PlayContext => ({
  cells, projectId: "p1", session: { jwt: "t", username: "dev", createdAt: "" } as PlayContext["session"],
})
const players = (name: string) => FakeAudio.instances.filter((a) => a.src.includes(name))

/** A line at `start` with a 2s take (no source clip — the picture is the master). */
function line(id: string, start: number): CellData {
  const takeId = `audio-${id}-1700000000-take.wav`
  return {
    id, fileId: "f1", original: "", translated: "", medium: "text", startTime: start, endTime: start + 4,
    selectedAudioId: takeId,
    attachments: { [takeId]: { type: "audio", url: `http://audio.test/take-${id}.wav`, durationMs: 2000 } },
  } as unknown as CellData
}

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

describe("planUpcomingDubs", () => {
  it("names the next two takes to start on a track, soonest first, at the clip seconds they will fire with", () => {
    const cells = [line("c", 12), line("a", 2), line("b", 7)]
    const next = planUpcomingDubs(cells, 1, { masterIsExternal: true })
    expect(next.map((n) => [n.cellId, n.dueSec, n.startAtClipSec])).toEqual([["a", 2, 0], ["b", 7, 0]])
    // Once line a is sounding, it is no longer upcoming.
    expect(planUpcomingDubs(cells, 2.5, { masterIsExternal: true }).map((n) => n.cellId)).toEqual(["b", "c"])
  })

  it("counts a sounding take's next piece as what its line starts next", () => {
    const A = "audio-a-1700000000-take.wav", B = "audio-a-1700000500-piece.wav"
    const cut = {
      ...line("a", 2),
      attachments: {
        [A]: { type: "audio", url: "http://audio.test/take-a.wav", slot: "recording", durationMs: 4000, trimEndMs: 1500 },
        [B]: { type: "audio", url: "http://audio.test/take-a.wav", slot: "recording", pieceOf: A, durationMs: 4000, trimStartMs: 2000 },
      },
    } as unknown as CellData
    const next = planUpcomingDubs([cut, line("b", 7)], 2.5, { masterIsExternal: true })
    expect(next.map((n) => [n.audioId, n.dueSec, n.startAtClipSec])).toEqual([[B, 4, 2], ["audio-b-1700000000-take.wav", 7, 0]])
  })
})

describe("under a picture (or the virtual clock)", () => {
  it("makes the next line's player while this one plays, and plays that one when it is due", async () => {
    startExternalDubs(ctxFor([line("a", 2), line("b", 7), line("c", 12)]))
    setExternalDubsPlaying(true)
    tickExternalDubs(1)
    await settle()
    // Nothing is due yet, but lines a and b are made and parked.
    expect(players("take-a")).toHaveLength(1)
    expect(players("take-b")).toHaveLength(1)
    expect(players("take-b")[0].paused).toBe(true)
    tickExternalDubs(2.02)
    await settle()
    expect(players("take-a")).toHaveLength(1)
    expect(players("take-a")[0].paused).toBe(false)
    // Line b's player waited ready while a played.
    tickExternalDubs(7.02)
    await settle()
    expect(players("take-b")).toHaveLength(1)
    expect(players("take-b")[0].paused).toBe(false)
  })

  it("throws the made-ready players away on a jump, and makes the ones after where it landed", async () => {
    startExternalDubs(ctxFor([line("a", 2), line("b", 7), line("c", 12)]))
    setExternalDubsPlaying(true)
    tickExternalDubs(1)
    await settle()
    const [a, b] = [players("take-a")[0], players("take-b")[0]]
    tickExternalDubs(9) // a jump forward
    await settle()
    expect(a.src).toBe("")
    expect(b.src).toBe("")
    expect(players("take-c").filter((el) => el.src !== "")).toHaveLength(1)
  })

  it("throws them away when the picture lets go of the dubs", async () => {
    startExternalDubs(ctxFor([line("a", 2), line("b", 7)]))
    setExternalDubsPlaying(true)
    tickExternalDubs(1)
    await settle()
    stopExternalDubs()
    expect(FakeAudio.instances.every((el) => el.src === "")).toBe(true)
  })

  it("starts a made-ready line at its start, not on the clock's next tick", async () => {
    startExternalDubs(ctxFor([line("a", 2), line("b", 7)]))
    setExternalDubsPlaying(true)
    tickExternalDubs(6.85)
    await settle()
    tickExternalDubs(6.9) // the last tick before b is due
    await wait(250)
    expect(players("take-b")[0].paused).toBe(false)
  })
})

describe("under an imported recording (the queue's master)", () => {
  const CLIP = "http://audio.test/clip.mp3"
  const SOURCE_ID = "audio-f1-1690000000-shared.mp3"
  /** A section of the shared recording with its dub take starting with it. */
  function section(id: string, start: number, end: number): CellData {
    const takeId = `audio-${id}-1700000000-take.wav`
    return {
      id, fileId: "f1", original: "", translated: "", medium: "media", startTime: start, endTime: end,
      selectedAudioId: takeId,
      attachments: {
        [takeId]: { type: "audio", url: `http://audio.test/take-${id}.wav`, durationMs: 2000 },
        [SOURCE_ID]: { type: "audio", url: CLIP },
      },
    } as unknown as CellData
  }
  const master = () => FakeAudio.instances.find((a) => a.src === CLIP)!

  it("makes the next section's dub while this section plays, and plays it at the boundary", async () => {
    startQueue(ctxFor([section("s1", 0, 5), section("s2", 5, 10), section("s3", 10, 15)]), 0)
    await settle()
    expect(players("take-s2")).toHaveLength(1)
    expect(players("take-s2")[0].paused).toBe(true)
    master().tick(5.01)
    await settle()
    expect(players("take-s2")).toHaveLength(1)
    expect(players("take-s2")[0].paused).toBe(false)
  })

  it("fires it at the section's start, between the master's ticks", async () => {
    startQueue(ctxFor([section("s1", 0, 5), section("s2", 5, 10)]), 0)
    await settle()
    master().tick(4.8)
    // The element's clock reaches the boundary; its next timeupdate is far off.
    master().currentTime = 4.995
    await wait(300)
    expect(players("take-s2")[0].paused).toBe(false)
  })
})
