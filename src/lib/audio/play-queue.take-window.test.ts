// AQU-1642 follow-up (Sam, 2026-10-17): in the Audio view the bottom bar's
// player is the one player — the card and the ⋯ menu's Play drive it. So it
// must play a line's take the way the card always has: only the kept part (its
// trim, or a split take's pieces with the space between them skipped), ending
// at the trim rather than up to a timeupdate later. And the card needs to open
// the run at a line, at a second of it, and move within the line it is on.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook } from "@testing-library/react"

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
  getQueueProgress,
  getQueueState,
  masterWindowForCell,
  planSeek,
  seekQueueInCell,
  setQueueAudibility,
  startQueue,
  startQueueAtCell,
  stopQueue,
  useQueueCellKind,
  useQueueCellPosition,
  type PlayContext,
} from "./play-queue"
import type { CellData } from "@/hooks/useCells"

class FakeAudio {
  static instances: FakeAudio[] = []
  src: string
  paused = true
  ended = false
  muted = false
  volume = 1
  playbackRate = 1
  currentTime = 0
  duration = 10
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
  addEventListener(type: string, fn: () => void): void {
    if (type === "canplay" || type === "seeked") queueMicrotask(fn)
  }
  removeEventListener(): void {}
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
const player = (id: string) => FakeAudio.instances.filter((a) => a.src.includes(`take-${id}`)).at(-1)!
const opened = async (id: string): Promise<FakeAudio> => {
  await settle()
  const el = player(id)
  el.onloadedmetadata?.()
  return el
}

/** A verse with one take; `trim` in ms, or `pieces` for a split take. */
function verse(
  id: string,
  opts: { trim?: [number | null, number | null]; pieces?: Array<[number, number]> } = {},
): CellData {
  const takeId = `audio-${id}-1700000000-take.wav`
  const url = `http://audio.test/take-${id}.wav`
  const attachments: Record<string, unknown> = {
    [takeId]: {
      type: "audio", url, slot: "recording",
      ...(opts.trim ? { trimStartMs: opts.trim[0], trimEndMs: opts.trim[1] } : {}),
      ...(opts.pieces ? { trimStartMs: opts.pieces[0][0], trimEndMs: opts.pieces[0][1] } : {}),
    },
  }
  for (const [i, [s, e]] of (opts.pieces ?? []).slice(1).entries()) {
    attachments[`audio-${id}-170000000${i + 1}-piece.wav`] = {
      type: "audio", url, slot: "recording", pieceOf: takeId, trimStartMs: s, trimEndMs: e,
    }
  }
  return {
    id, fileId: "f1", original: "", translated: "", type: "text",
    selectedAudioId: takeId, attachments,
  } as unknown as CellData
}

beforeEach(() => {
  FakeAudio.instances = []
  vi.stubGlobal("Audio", FakeAudio)
  setQueueAudibility({ source: true, target: true })
})
afterEach(() => {
  stopQueue()
  vi.unstubAllGlobals()
})

describe("a line's own take plays its kept part", () => {
  it("reads the trim, or a split take's pieces with the space between them as a gap", () => {
    expect(masterWindowForCell(verse("a"))).toBeNull()
    expect(masterWindowForCell(verse("a", { trim: [500, 1500] }))).toEqual({ start: 0.5, end: 1.5, take: true })
    expect(masterWindowForCell(verse("a", { trim: [500, null] }))).toEqual({ start: 0.5, end: Number.POSITIVE_INFINITY, take: true })
    expect(masterWindowForCell(verse("a", { pieces: [[0, 1000], [2000, 3000]] }))).toEqual({
      start: 0, end: 3, gaps: [{ start: 1, end: 2 }], take: true,
    })
  })

  it("starts at the trim's start and moves on to the next line at its end", async () => {
    startQueue(ctxFor([verse("a", { trim: [500, 1500] }), verse("b")]), 0)
    const a = await opened("a")
    expect(a.currentTime).toBe(0.5)
    a.tick(1.2)
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "a" })
    a.tick(1.5)
    await settle()
    expect(getQueueState()).toMatchObject({ cellId: "b" })
    expect(a.paused).toBe(true)
  })

  it("stops at the trim's end on time, without waiting for a timeupdate", async () => {
    startQueue(ctxFor([verse("a", { trim: [0, 300] }), verse("b")]), 0)
    await opened("a")
    await new Promise((r) => setTimeout(r, 450))
    await settle()
    expect(getQueueState()).toMatchObject({ cellId: "b" })
  })

  it("steps over a split take's gap", async () => {
    startQueue(ctxFor([verse("a", { pieces: [[0, 1000], [2000, 3000]] })]), 0)
    const a = await opened("a")
    a.tick(1.0)
    expect(a.currentTime).toBe(2)
    expect(getQueueProgress().currentTime).toBe(2)
  })

  it("keeps the bar's scrubber inside the kept part", () => {
    const cells = [verse("a", { trim: [500, 1500] })]
    expect(planSeek(cells, 0, "http://audio.test/take-a.wav", 0.1)).toEqual({ kind: "element", index: 0, seconds: 0.5 })
    expect(planSeek(cells, 0, "http://audio.test/take-a.wav", 9)).toEqual({ kind: "element", index: 0, seconds: 1.5 })
  })
})

describe("the Audio view's controls on the run", () => {
  it("opens the run at a line, paused at a second of it", async () => {
    const cells = [verse("a"), verse("b"), verse("c")]
    startQueueAtCell(ctxFor(cells), 1, { atSeconds: 2.5, play: false })
    const b = await opened("b")
    expect(getQueueState()).toMatchObject({ kind: "paused", cellId: "b" })
    expect(b.currentTime).toBe(2.5)
    expect(b.paused).toBe(true)
  })

  it("plays on from that line into the next", async () => {
    const cells = [verse("a"), verse("b"), verse("c")]
    startQueueAtCell(ctxFor(cells), 1)
    const b = await opened("b")
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b" })
    b.ended = true
    b.onended?.()
    await settle()
    expect(getQueueState()).toMatchObject({ cellId: "c" })
  })

  it("moves within the line it is on, and only that line", async () => {
    startQueueAtCell(ctxFor([verse("a", { trim: [500, 4000] }), verse("b")]), 0, { play: false })
    const a = await opened("a")
    expect(seekQueueInCell("b", 1)).toBe(false)
    expect(seekQueueInCell("a", 2)).toBe(true)
    expect(a.currentTime).toBe(2)
    expect(seekQueueInCell("a", 0.1)).toBe(true)
    expect(a.currentTime).toBe(0.5)
    expect(getQueueState()).toMatchObject({ kind: "paused", cellId: "a" })
  })

  it("a move asked for while the line is still opening lands where the open does", async () => {
    startQueueAtCell(ctxFor([verse("a"), verse("b")]), 1, { play: false })
    expect(getQueueState()).toMatchObject({ kind: "loading", cellId: "b" })
    expect(seekQueueInCell("b", 3)).toBe(true)
    const b = await opened("b")
    expect(b.currentTime).toBe(3)
  })

  it("tells each line whether the run is on it, and where — paused too", async () => {
    const kindB = renderHook(() => useQueueCellKind("b"))
    const atB = renderHook(() => useQueueCellPosition("b"))
    const kindA = renderHook(() => useQueueCellKind("a"))
    expect(kindB.result.current).toBeNull()
    await act(async () => {
      startQueueAtCell(ctxFor([verse("a"), verse("b")]), 1, { atSeconds: 1.25, play: false })
      await opened("b")
    })
    expect(kindB.result.current).toBe("paused")
    expect(atB.result.current).toBe(1.25)
    expect(kindA.result.current).toBeNull()
    await act(async () => { await player("b").play() })
    expect(kindB.result.current).toBe("playing")
    act(() => stopQueue())
    expect(kindB.result.current).toBeNull()
    expect(atB.result.current).toBeNull()
  })
})
