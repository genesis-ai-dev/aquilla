import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const uploads: Array<{ audioId: string; ext: string; size: number }> = []
const attaches: Array<Record<string, unknown>> = []
const places: Array<Record<string, unknown>> = []

vi.mock("@/lib/audio/upload", async (orig) => {
  const real = await orig<typeof import("@/lib/audio/upload")>()
  return {
    ...real,
    fetchCellAudio: vi.fn(async () => new Uint8Array(1000)),
    uploadCellAudio: vi.fn(async (args: { audioId: string; ext: string; blob: Blob }) => {
      uploads.push({ audioId: args.audioId, ext: args.ext, size: args.blob.size })
      return { audioId: args.audioId, ext: args.ext, url: real.buildFrontierAudioUrl(args.audioId, args.ext), sizeBytes: args.blob.size }
    }),
  }
})
vi.mock("@/lib/audio/bytes-cache", () => ({ audioCacheGet: vi.fn(async () => null) }))
vi.mock("@/lib/sync/events-emit", () => ({
  emitCellAudioAttach: vi.fn(async (input: Record<string, unknown>) => { attaches.push(input); return "ev" }),
  emitCellAudioPlace: vi.fn(async (input: Record<string, unknown>) => { places.push(input); return "ev-place" }),
}))
vi.mock("@/lib/audio/audio-attachments-bus", () => ({ injectOptimisticAudioAttachment: vi.fn(), notifyAudioAttachmentsChanged: vi.fn() }))
// AQU-2492 (review, Nov 9): the Undo steps a join records.
const steps = vi.hoisted(() => [] as Array<Record<string, unknown>>)
const pendings = vi.hoisted(() => [] as Array<Promise<boolean> | undefined>)
vi.mock("@/lib/history/history", async (orig) => ({
  ...(await orig<typeof import("@/lib/history/history")>()),
  recordStep: (step: Record<string, unknown>, _scope?: unknown, opts?: { pending?: Promise<boolean> }) => {
    steps.push(step)
    pendings.push(opts?.pending)
    return "step-id"
  },
}))
vi.mock("@/lib/audio/sync-token-fetcher", () => ({ audioSyncTokenFetcherForSession: () => async () => "token" }))
vi.mock("@/lib/audio/decode-mono", () => ({
  TARGET_RATE: 1000,
  // 1000 "samples" a second: a recording of 1000 bytes is one second long.
  decodeToMono48k: vi.fn(async (bytes: Uint8Array) => Float32Array.from({ length: bytes.length }, (_, i) => i)),
  concatPcm: (clips: Float32Array[]) => {
    const out = new Float32Array(clips.reduce((n, c) => n + c.length, 0))
    let at = 0
    for (const c of clips) { out.set(c, at); at += c.length }
    return out
  },
}))
vi.mock("@/lib/audio/wav-encode", () => ({
  encodeWavPcm16: (samples: Float32Array) => new Blob([new Uint8Array(samples.length)]),
}))

import { joinTakePieces, wholeRecordingOf, type JoinPiece } from "./join-pieces"
import { buildTimelineLayout } from "@/lib/timeline/layout"
import type { CellData } from "@/hooks/useCells"

const session = { jwt: "jwt", username: "dev", createdAt: "" } as never
const URL_A = "frontier-audio://audio-c1-1700000000000-a.wav"

beforeEach(() => {
  places.length = 0
  uploads.length = 0
  attaches.length = 0
  steps.length = 0
  pendings.length = 0
})

describe("wholeRecordingOf", () => {
  const piece = (trimStartMs: number | null, trimEndMs: number | null, url = URL_A): JoinPiece => ({ audioId: `p${trimStartMs}`, url, trimStartMs, trimEndMs, durationMs: 1200 })
  it("is the recording when the pieces cover it end to end", () => {
    expect(wholeRecordingOf([piece(null, 300), piece(300, 800), piece(800, null)])).toBe(URL_A)
    expect(wholeRecordingOf([piece(0, 300), piece(300, 1200)])).toBe(URL_A)
  })
  it("is nothing when a piece was trimmed, or the pieces are of different recordings", () => {
    expect(wholeRecordingOf([piece(100, 300), piece(300, null)])).toBeNull()
    expect(wholeRecordingOf([piece(null, 300), piece(400, null)])).toBeNull()
    expect(wholeRecordingOf([piece(null, 300), piece(300, 1000)])).toBeNull()
    expect(wholeRecordingOf([piece(null, 300), piece(300, null, "frontier-audio://other.wav")])).toBeNull()
  })
})

/** The line the pieces are on: 10 s into its file, 10 s long. */
const LINE_C1 = { id: "c1", fileId: "f1", startTime: 10, endTime: 20 } as unknown as CellData

describe("joinTakePieces", () => {
  const args = { session, projectId: "p1", fileId: "f1", cellId: "c1", slot: "recording", targetLang: "za", username: "dev", line: LINE_C1, onLayer: false }

  it("pieces that tile their recording: a new take of the same bytes, nothing uploaded", async () => {
    const id = await joinTakePieces({ ...args, pieces: [
      { audioId: "a.wav", url: URL_A, trimStartMs: null, trimEndMs: 300, durationMs: 1200, mimeType: "audio/wav" },
      { audioId: "b.wav", url: URL_A, trimStartMs: 300, trimEndMs: null, durationMs: 1200, mimeType: "audio/wav" },
    ] })
    expect(uploads).toHaveLength(0)
    expect(attaches).toEqual([expect.objectContaining({ cellId: "c1", url: URL_A, audioId: id, slot: "recording", targetLang: "za", durationMs: 1200, label: undefined })])
    expect(id).toMatch(/^audio-c1-\d+-\w+\.wav$/)
    expect(id).not.toBe("a.wav")
  })

  // Sam, Oct 29 (question 7): the joined take is named "Take N", as the
  // recorder names takes. The caller works N out (nextTakeLabel); both ways of
  // joining store it on the new take.
  it("the joined take carries the name it is given, on both ways of joining", async () => {
    await joinTakePieces({ ...args, label: "Take 3", pieces: [
      { audioId: "a.wav", url: URL_A, trimStartMs: null, trimEndMs: 300, durationMs: 1200 },
      { audioId: "b.wav", url: URL_A, trimStartMs: 300, trimEndMs: null, durationMs: 1200 },
    ] })
    await joinTakePieces({ ...args, label: "Take 4", pieces: [
      { audioId: "a.wav", url: URL_A, trimStartMs: 100, trimEndMs: 300 },
      { audioId: "b.wav", url: URL_A, trimStartMs: 500, trimEndMs: 900 },
    ] })
    expect(attaches.map((a) => a.label)).toEqual(["Take 3", "Take 4"])
  })

  it("trimmed pieces: their audible parts, joined in order and uploaded as one WAV", async () => {
    await joinTakePieces({ ...args, pieces: [
      { audioId: "a.wav", url: URL_A, trimStartMs: 100, trimEndMs: 300 },
      { audioId: "b.wav", url: URL_A, trimStartMs: 500, trimEndMs: 900 },
    ] })
    // 200 ms + 400 ms of a 1 kHz "recording".
    expect(uploads).toEqual([expect.objectContaining({ ext: "wav", size: 600 })])
    expect(attaches).toEqual([expect.objectContaining({ durationMs: 600, mimeType: "audio/wav", url: expect.stringMatching(/^frontier-audio:\/\/audio-c1-/) })])
  })

  // AQU-2492 (review, Nov 9): joining left no Undo step, so ⌘Z after it undid
  // something else. Both ways of joining record the joined take as added:
  // Undo takes it away and the take in pieces plays again.
  it("records the joined take as an Undo step, on both ways of joining", async () => {
    const history = { selectedBefore: "a.wav" }
    const tiled = await joinTakePieces({ ...args, history, pieces: [
      { audioId: "a.wav", url: URL_A, trimStartMs: null, trimEndMs: 300, durationMs: 1200 },
      { audioId: "b.wav", url: URL_A, trimStartMs: 300, trimEndMs: null, durationMs: 1200 },
    ] })
    const uploaded = await joinTakePieces({ ...args, history, pieces: [
      { audioId: "a.wav", url: URL_A, trimStartMs: 100, trimEndMs: 300 },
      { audioId: "b.wav", url: URL_A, trimStartMs: 500, trimEndMs: 900 },
    ] })
    expect(steps).toEqual([tiled, uploaded].map((audioId) => expect.objectContaining({
      kind: "take.add",
      labelKey: "editor.history.stepJoinTake",
      fileId: "f1",
      data: { cellId: "c1", audioId, slot: "recording", selectedBefore: "a.wav" },
    })))
  })

  // AQU-2492 (review, Nov 9), finding 15: recorded when the join STARTS,
  // waiting on it — ⌘Z pressed while it decodes and uploads waits for it and
  // undoes the join, never an older step. A failed join leaves no step.
  it("records its step as it starts, before the upload, waiting on the join", async () => {
    const { uploadCellAudio } = await import("@/lib/audio/upload")
    let stepsAtUpload = -1
    vi.mocked(uploadCellAudio).mockImplementationOnce(async (a: { audioId: string; ext: string; blob: Blob }) => {
      stepsAtUpload = steps.length
      return { audioId: a.audioId, ext: a.ext, url: `frontier-audio://${a.audioId}.${a.ext}`, sizeBytes: a.blob.size }
    })
    const id = await joinTakePieces({ ...args, history: { selectedBefore: "a.wav" }, pieces: [
      { audioId: "a.wav", url: URL_A, trimStartMs: 100, trimEndMs: 300 },
      { audioId: "b.wav", url: URL_A, trimStartMs: 500, trimEndMs: 900 },
    ] })
    expect(stepsAtUpload).toBe(1)
    expect(steps[0]).toMatchObject({ kind: "take.add", data: { audioId: id } })
    expect(attaches[0]).toMatchObject({ audioId: id })
    expect(await pendings[0]).toBe(true)
  })

  it("a join that fails leaves its step to be dropped", async () => {
    const { uploadCellAudio } = await import("@/lib/audio/upload")
    vi.mocked(uploadCellAudio).mockRejectedValueOnce(new Error("audio upload failed (500)"))
    await expect(joinTakePieces({ ...args, history: { selectedBefore: "a.wav" }, pieces: [
      { audioId: "a.wav", url: URL_A, trimStartMs: 100, trimEndMs: 300 },
      { audioId: "b.wav", url: URL_A, trimStartMs: 500, trimEndMs: 900 },
    ] })).rejects.toThrow(/upload failed/)
    expect(steps).toHaveLength(1)
    expect(await pendings[0]).toBe(false)
  })

  it("records nothing when no step is asked for", async () => {
    await joinTakePieces({ ...args, pieces: [
      { audioId: "a.wav", url: URL_A, trimStartMs: null, trimEndMs: 300, durationMs: 1200 },
      { audioId: "b.wav", url: URL_A, trimStartMs: 300, trimEndMs: null, durationMs: 1200 },
    ] })
    expect(steps).toEqual([])
  })
})

// AQU-2491 (review, Nov 9): a line recorded before AQU-2491 holds the
// recorder's pre-roll as its place, and a take with no place of its own reads
// that one. A take recorded since has its own (-200, its pre-roll), and so do
// its pieces. The joined take is made from them, so it keeps that place, in
// both timings, instead of reading the line's and moving.
describe("joinTakePieces: the joined take keeps its pieces' place (AQU-2491)", () => {
  const args = { session, projectId: "p1", fileId: "f1", cellId: "c1", slot: "recording", targetLang: "za", username: "dev", line: LINE_C1, onLayer: false }

  it("on both ways of joining, the joined take is placed where its first piece is", async () => {
    const a = await joinTakePieces({ ...args, pieces: [
      { audioId: "a.wav", url: URL_A, trimStartMs: null, trimEndMs: 300, durationMs: 1200, targetOffsetMs: -200, recordingsOffsetMs: 40 },
      { audioId: "b.wav", url: URL_A, trimStartMs: 300, trimEndMs: null, durationMs: 1200, targetOffsetMs: -200, recordingsOffsetMs: 40 },
    ] })
    const b = await joinTakePieces({ ...args, pieces: [
      { audioId: "a.wav", url: URL_A, trimStartMs: 100, trimEndMs: 300, targetOffsetMs: -200 },
      { audioId: "b.wav", url: URL_A, trimStartMs: 500, trimEndMs: 900, targetOffsetMs: -200 },
    ] })
    // The second join decodes and joins the pieces' sound, so the joined clip
    // starts where the first piece's SOUND did: its 100 ms head trim is gone,
    // and its clip's start moves 100 ms later following the source, to -100
    // (this test used to expect -200, a joined take sounding 100 ms early).
    // Following the recordings a main-track take sounds from its place, so
    // that place stays where the piece read it: its place following the
    // source, -200, which reads as its line's start there (0), written as its
    // own so it no longer follows the moved place following the source.
    expect(places).toEqual([
      expect.objectContaining({ audioId: a, targetOffsetMs: -200, recordingsOffsetMs: 40, targetLang: "za" }),
      expect.objectContaining({ audioId: b, targetOffsetMs: -100, recordingsOffsetMs: 0 }),
    ])
  })

  it("pieces with no place of their own: nothing is placed, and the joined take reads the line's, as they do", async () => {
    await joinTakePieces({ ...args, pieces: [
      { audioId: "a.wav", url: URL_A, trimStartMs: null, trimEndMs: 300, durationMs: 1200 },
      { audioId: "b.wav", url: URL_A, trimStartMs: 300, trimEndMs: null, durationMs: 1200 },
    ] })
    expect(places).toEqual([])
  })
})

// AQU-2491 (merge review, Nov 13, MUST 1): a take's place is where its CLIP
// starts. Joined from trimmed pieces, the new recording starts at the first
// piece's sound, its head trim gone; kept at the piece's place, the joined take
// sounded that head trim early following the source (and, since AQU-2495 lets
// a head-trimmed clip start before 0:00, could sound before 0:00). The joined
// take sounds from exactly where its first piece did, in both timings and on
// every kind of track. Each case cuts a line's 8 s take at 6 s and joins it,
// then asks each timing where the piece sounded and where the joined take does.
describe("joinTakePieces: the joined take sounds where its first piece did (AQU-2491, merge review)", () => {
  const TRACK = "01a17e67-ef58-74f7-a093-be935876197b"
  const P1 = "audio-c1-1700000000001-a.wav"
  const P2 = "audio-c1-1700000000002-b.wav"
  const J = "audio-c1-1700000000009-j.wav"
  type Place = { targetOffsetMs?: number | null; recordingsOffsetMs?: number | null }

  beforeEach(async () => {
    const { fetchCellAudio } = await import("@/lib/audio/upload")
    // An 8 s recording of the mocked 1 kHz kind.
    vi.mocked(fetchCellAudio).mockImplementation(async () => new Uint8Array(8000))
  })
  afterEach(async () => {
    const { fetchCellAudio } = await import("@/lib/audio/upload")
    vi.mocked(fetchCellAudio).mockImplementation(async () => new Uint8Array(1000))
  })

  /** A take on `slot`, selected on line `id`. */
  function lineWith(id: string, startSec: number, slot: string, atts: Record<string, Record<string, unknown>>, first: string, meta?: Record<string, unknown>): CellData {
    const main = slot === "recording"
    return {
      id, fileId: "f1", original: "", translated: "", medium: "media", startTime: startSec, endTime: startSec + 10,
      ...(meta ? { metadata: meta } : {}),
      ...(main ? { selectedAudioId: first } : {}),
      selectedBySlot: { [slot]: first },
      attachments: Object.fromEntries(Object.entries(atts).map(([k, a]) => [k, { type: "audio", url: URL_A, slot, ...a }])),
    } as unknown as CellData
  }

  /** Line c1 at `startSec`, its 8 s take with `headMs` trimmed off its start, cut at 6 s. */
  function cutLine(startSec: number, place: Place, headMs: number, slot = "recording", meta?: Record<string, unknown>) {
    const line = lineWith("c1", startSec, slot, {
      [P1]: { durationMs: 8000, ...(headMs ? { trimStartMs: headMs } : {}), trimEndMs: 6000, ...place },
      [P2]: { durationMs: 8000, trimStartMs: 6000, pieceOf: P1, ...place },
    }, P1, meta)
    const pieces: JoinPiece[] = [P1, P2].map((audioId) => {
      const a = line.attachments![audioId] as unknown as JoinPiece
      return { audioId, url: URL_A, trimStartMs: a.trimStartMs ?? null, trimEndMs: a.trimEndMs ?? null, durationMs: 8000, targetOffsetMs: a.targetOffsetMs ?? null, recordingsOffsetMs: a.recordingsOffsetMs ?? null }
    })
    return { line, pieces }
  }

  /** The same line with the joined take in its pieces' stead, placed as the join placed it. */
  function joinedLine(line: CellData, slot: string): CellData {
    const placed = places[0] ?? {}
    return lineWith(line.id, line.startTime!, slot, {
      [J]: {
        durationMs: attaches[0].durationMs,
        ...(placed.targetOffsetMs != null ? { targetOffsetMs: placed.targetOffsetMs } : {}),
        ...(placed.recordingsOffsetMs != null ? { recordingsOffsetMs: placed.recordingsOffsetMs } : {}),
      },
    }, J, line.metadata as Record<string, unknown> | undefined)
  }

  /** Where a take's sound starts, in each timing (the line before it, if any, first). */
  function soundsAt(cells: CellData[], audioId: string, layer: boolean) {
    const cell = cells[cells.length - 1]
    const att = cell.attachments![audioId] as never
    const opts = { standInLenSec: () => 2, layerSlots: [TRACK], layerTrackSlots: layer ? [TRACK] : [] }
    return {
      source: buildTimelineLayout("dubbing", cells, cells).targetGeom(cell, att, audioId)!.start,
      recordings: buildTimelineLayout("audioFirst", cells, cells, null, opts).targetGeom(cell, att, audioId)!.start,
    }
  }

  async function join(line: CellData, pieces: JoinPiece[], slot: string, onLayer: boolean) {
    await joinTakePieces({ session, projectId: "p1", fileId: "f1", cellId: "c1", slot, username: "dev", pieces, line, onLayer })
  }

  /** Cut, join, and compare where the piece and the joined take sound. */
  async function cutAndJoin(o: { startSec: number; place: Place; headMs: number; slot?: string; layer?: boolean; before?: CellData; meta?: Record<string, unknown> }) {
    const slot = o.slot ?? "recording"
    const layer = o.layer ?? false
    const { line, pieces } = cutLine(o.startSec, o.place, o.headMs, slot, o.meta)
    await join(line, pieces, slot, layer)
    const ahead = o.before ? [o.before] : []
    return {
      piece: soundsAt([...ahead, line], P1, layer),
      joined: soundsAt([...ahead, joinedLine(line, slot)], J, layer),
    }
  }

  it("following the source, with the first piece's start trimmed off: the joined take sounds from the same moment (0:14, not 0:10)", async () => {
    const { piece, joined } = await cutAndJoin({ startSec: 10, place: { targetOffsetMs: 0, recordingsOffsetMs: null }, headMs: 4000 })
    expect(piece.source).toBeCloseTo(14, 6)
    expect(joined.source).toBeCloseTo(14, 6)
  })

  it("AQU-2495: a head-trimmed clip that starts before 0:00 joins into a take that still sounds from 0:00, never before", async () => {
    // A line at 2 s, its clip at -4 s with 4 s trimmed off: it sounds from 0:00.
    const { piece, joined } = await cutAndJoin({ startSec: 2, place: { targetOffsetMs: -6000, recordingsOffsetMs: null }, headMs: 4000 })
    expect(piece.source).toBeCloseTo(0, 6)
    expect(joined.source).toBeCloseTo(0, 6)
  })

  it("a piece with no place of its own reads its line's: the joined take sounds where it did there too", async () => {
    const { piece, joined } = await cutAndJoin({ startSec: 10, place: {}, headMs: 4000, meta: { target_offset_ms: 500 } })
    expect(piece.source).toBeCloseTo(14.5, 6)
    expect(joined).toEqual({ source: expect.closeTo(piece.source, 6), recordings: expect.closeTo(piece.recordings, 6) })
  })

  it("an untrimmed first piece: the joined take keeps its place exactly, as before", async () => {
    const { line } = cutLine(10, { targetOffsetMs: -200, recordingsOffsetMs: 40 }, 0)
    // A gap cut out between the pieces: decoded and joined, nothing off its start.
    const pieces: JoinPiece[] = [
      { audioId: P1, url: URL_A, trimStartMs: null, trimEndMs: 3000, durationMs: 8000, targetOffsetMs: -200, recordingsOffsetMs: 40 },
      { audioId: P2, url: URL_A, trimStartMs: 5000, trimEndMs: null, durationMs: 8000, targetOffsetMs: -200, recordingsOffsetMs: 40 },
    ]
    await join(line, pieces, "recording", false)
    expect(uploads).toHaveLength(1)
    expect(places).toEqual([expect.objectContaining({ targetOffsetMs: -200, recordingsOffsetMs: 40 })])
  })

  describe("a take on a track made a layer (music, effects)", () => {
    it("with a place of its own following the recordings: sounds from the same moment in both timings", async () => {
      const { piece, joined } = await cutAndJoin({ startSec: 10, place: { targetOffsetMs: 0, recordingsOffsetMs: 1000 }, headMs: 4000, slot: TRACK, layer: true })
      expect(piece).toEqual({ source: expect.closeTo(14, 6), recordings: expect.closeTo(5, 6) })
      expect(joined).toEqual({ source: expect.closeTo(14, 6), recordings: expect.closeTo(5, 6) })
    })

    it("with none following the recordings: sounds from the same moment in both timings", async () => {
      const { piece, joined } = await cutAndJoin({ startSec: 10, place: { targetOffsetMs: 500, recordingsOffsetMs: null }, headMs: 4000, slot: TRACK, layer: true })
      expect(piece).toEqual({ source: expect.closeTo(14.5, 6), recordings: expect.closeTo(4.5, 6) })
      expect(joined).toEqual({ source: expect.closeTo(14.5, 6), recordings: expect.closeTo(4.5, 6) })
    })
  })

  describe("following the recordings, on the main track: unchanged (the take sounds from its place there)", () => {
    it("a place of its own there is kept", async () => {
      const { piece, joined } = await cutAndJoin({ startSec: 10, place: { targetOffsetMs: 0, recordingsOffsetMs: 700 }, headMs: 4000 })
      expect(piece.recordings).toBeCloseTo(0.7, 6)
      expect(joined.recordings).toBeCloseTo(0.7, 6)
    })

    it("no place of its own there: it still sounds where its place following the source put it, not a head trim later", async () => {
      const { piece, joined } = await cutAndJoin({ startSec: 10, place: { targetOffsetMs: 500, recordingsOffsetMs: null }, headMs: 4000 })
      expect(piece.recordings).toBeCloseTo(0.5, 6)
      expect(joined.recordings).toBeCloseTo(0.5, 6)
    })

    it("a recorder's pre-roll (-200) after a recorded line: still on its line's start, never pulled back over the take before it", async () => {
      const before = lineWith("c0", 0, "recording", { "audio-c0-1700000000000-x.wav": { durationMs: 3000 } }, "audio-c0-1700000000000-x.wav")
      const { piece, joined } = await cutAndJoin({ startSec: 10, place: { targetOffsetMs: -200, recordingsOffsetMs: null }, headMs: 4000, before })
      expect(joined.recordings).toBeCloseTo(piece.recordings, 6)
      expect(joined.source).toBeCloseTo(piece.source, 6)
    })
  })
})
