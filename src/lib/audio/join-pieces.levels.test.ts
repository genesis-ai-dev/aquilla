// AQU-2494 (browser pass, Nov 12): "Join into one recording" gives the joined
// take what undoing the cut would give it — the take's volume and fades, read
// back off its pieces (`levelBeforeCut`, the cut's own rule run backwards).
// It played at the recorded level with no fades: a +6 dB take with a 300 ms
// fade-in and a 500 ms fade-out, cut, then joined, came back flat.
//
// The writes land in a small store, as the projection keeps them: an attach
// adds a take and plays it, a gain sets its level, a remove only marks it
// removed, and choosing a removed take brings it back as it was.
import { beforeEach, describe, expect, it, vi } from "vitest"

type Stored = {
  url: string
  slot: string
  gainDb?: number | null
  fadeInMs?: number | null
  fadeOutMs?: number | null
  trimStartMs?: number | null
  trimEndMs?: number | null
  durationMs?: number | null
  isDeleted?: boolean
}
const takes: Record<string, Stored> = {}
const playing: Record<string, string | null> = {}
const events: Array<{ kind: string; audioId: string }> = []
const gainInputs: Array<Record<string, unknown>> = []
const painted: Array<{ att: Record<string, unknown>; eventId: unknown }> = []

vi.mock("@/lib/audio/upload", async (orig) => {
  const real = await orig<typeof import("@/lib/audio/upload")>()
  return {
    ...real,
    fetchCellAudio: vi.fn(async () => new Uint8Array(3400)),
    uploadCellAudio: vi.fn(async (args: { audioId: string; ext: string; blob: Blob }) =>
      ({ audioId: args.audioId, ext: args.ext, url: real.buildFrontierAudioUrl(args.audioId, args.ext), sizeBytes: args.blob.size })),
  }
})
vi.mock("@/lib/audio/bytes-cache", () => ({ audioCacheGet: vi.fn(async () => null) }))
vi.mock("@/lib/sync/events-emit", () => ({
  emitCellAudioAttach: vi.fn(async (input: { audioId: string; url: string; slot: string; durationMs?: number }) => {
    events.push({ kind: "attach", audioId: input.audioId })
    takes[input.audioId] = { url: input.url, slot: input.slot, durationMs: input.durationMs ?? null }
    playing[input.slot] = input.audioId
    return `ev-attach-${input.audioId}`
  }),
  emitCellAudioGain: vi.fn(async (input: { audioId: string; gainDb: number | null; fadeInMs: number | null; fadeOutMs: number | null }) => {
    events.push({ kind: "gain", audioId: input.audioId })
    gainInputs.push(input)
    takes[input.audioId] = { ...takes[input.audioId], gainDb: input.gainDb, fadeInMs: input.fadeInMs, fadeOutMs: input.fadeOutMs }
    return `ev-gain-${input.audioId}`
  }),
}))
vi.mock("@/lib/audio/audio-attachments-bus", () => ({
  injectOptimisticAudioAttachment: vi.fn((_f: string, _c: string, att: Record<string, unknown>, eventId: unknown) => { painted.push({ att, eventId }) }),
  notifyAudioAttachmentsChanged: vi.fn(),
}))
vi.mock("@/lib/audio/sync-token-fetcher", () => ({ audioSyncTokenFetcherForSession: () => async () => "token" }))
vi.mock("@/lib/audio/decode-mono", () => ({
  TARGET_RATE: 1000,
  decodeToMono48k: vi.fn(async (bytes: Uint8Array) => new Float32Array(bytes.length)),
  concatPcm: (clips: Float32Array[]) => new Float32Array(clips.reduce((n, c) => n + c.length, 0)),
}))
vi.mock("@/lib/audio/wav-encode", () => ({ encodeWavPcm16: (samples: Float32Array) => new Blob([new Uint8Array(samples.length)]) }))

import { joinTakePieces, type JoinPiece } from "./join-pieces"
import { attachUploadedTake } from "./attach-file"
import { emitCellAudioGain } from "@/lib/sync/events-emit"
import { levelBeforeCut, levelsAfterCut } from "./cut-take"
import { takeStepHandlers, type TakeAddData } from "@/lib/history/take-steps"
import type { CodexCellAttachment } from "@/lib/codex-editor/types"

const session = { jwt: "jwt", username: "dev", createdAt: "" } as never
const URL_A = "frontier-audio://audio-c1-1700000000000-a.wav"
const args = { session, projectId: "p1", fileId: "f1", cellId: "c1", slot: "recording", username: "dev" }
/** The browser pass's take: 3.4 s, +6 dB, a 300 ms fade-in and a 500 ms fade-out. */
const TAKE = { gainDb: 6, fadeInMs: 300, fadeOutMs: 500, durationMs: 3400 }

/** The take cut at `atMs`, its pieces' levels as the cut gives them (the cut's own function). */
function cutAt(atMs: number, take: { gainDb: number | null; fadeInMs: number | null; fadeOutMs: number | null; durationMs: number } = TAKE): JoinPiece[] {
  const { first, second } = levelsAfterCut(take, atMs)
  const pieces: JoinPiece[] = [
    { audioId: "a.wav", url: URL_A, trimStartMs: null, trimEndMs: atMs, durationMs: take.durationMs, ...first },
    { audioId: "b.wav", url: URL_A, trimStartMs: atMs, trimEndMs: null, durationMs: take.durationMs, ...second },
  ]
  for (const p of pieces) takes[p.audioId] = { ...p, slot: "recording" }
  playing.recording = "a.wav"
  return pieces
}
const levelOf = (id: string) => ({ gainDb: takes[id]?.gainDb ?? null, fadeInMs: takes[id]?.fadeInMs ?? null, fadeOutMs: takes[id]?.fadeOutMs ?? null })

beforeEach(() => {
  for (const k of Object.keys(takes)) delete takes[k]
  for (const k of Object.keys(playing)) delete playing[k]
  events.length = 0
  gainInputs.length = 0
  painted.length = 0
})

describe("levelBeforeCut — the cut's rule, backwards", () => {
  it("gives back the level a cut split over the pieces, wherever the take was cut", () => {
    for (const at of [400, 1700, 2900]) {
      const { first, second } = levelsAfterCut(TAKE, at)
      expect(levelBeforeCut([first, second])).toEqual({ gainDb: 6, fadeInMs: 300, fadeOutMs: 500 })
    }
  })

  it("and over three pieces: a first piece cut again keeps the fade-in, the last keeps the fade-out", () => {
    const once = levelsAfterCut(TAKE, 2000)
    const twice = levelsAfterCut({ ...once.first, durationMs: 3400, trimEndMs: 2000 }, 1000)
    expect(levelBeforeCut([twice.first, twice.second, once.second])).toEqual({ gainDb: 6, fadeInMs: 300, fadeOutMs: 500 })
  })

  it("reads a cut stored before levels went with a cut (the first piece holding all three, the second none) as undoing it does", () => {
    expect(levelBeforeCut([{ gainDb: 6, fadeInMs: 300, fadeOutMs: 500 }, {}])).toEqual({ gainDb: 6, fadeInMs: 300, fadeOutMs: 500 })
  })

  it("a take with no level gives none", () => {
    const { first, second } = levelsAfterCut({ durationMs: 3400 }, 1700)
    expect(levelBeforeCut([first, second])).toEqual({ gainDb: null, fadeInMs: null, fadeOutMs: null })
  })
})

describe("Join into one recording keeps the take's volume and fades", () => {
  it("pieces that tile their recording: the joined take is stored at +6 dB with 300 / 500 ms, and painted so at once", async () => {
    const pieces = cutAt(1700)
    const id = await joinTakePieces({ ...args, pieces })
    expect(levelOf(id)).toEqual({ gainDb: 6, fadeInMs: 300, fadeOutMs: 500 })
    // The paint carries the level, and stays until the level's own event is read back.
    expect(painted).toEqual([{ att: expect.objectContaining({ audioId: id, gainDb: 6, fadeInMs: 300, fadeOutMs: 500 }), eventId: `ev-gain-${id}` }])
    // Nothing is written to the pieces.
    expect(events).toEqual([{ kind: "attach", audioId: id }, { kind: "gain", audioId: id }])
    expect(levelOf("a.wav")).toEqual({ gainDb: 6, fadeInMs: 300, fadeOutMs: null })
    expect(levelOf("b.wav")).toEqual({ gainDb: 6, fadeInMs: null, fadeOutMs: 500 })
  })

  it("on a lane, the level is written on that lane", async () => {
    await joinTakePieces({ ...args, targetLang: "za", pieces: cutAt(1700) })
    expect(gainInputs).toEqual([expect.objectContaining({ gainDb: 6, fadeInMs: 300, fadeOutMs: 500, targetLang: "za", author: "dev" })])
  })

  it("trimmed pieces (joined by decoding them): the same level", async () => {
    const pieces = cutAt(1700).map((p, i) => (i === 0 ? { ...p, trimStartMs: 100 } : { ...p, trimEndMs: 3300 }))
    const id = await joinTakePieces({ ...args, pieces })
    expect(takes[id].url).not.toBe(URL_A)
    expect(levelOf(id)).toEqual({ gainDb: 6, fadeInMs: 300, fadeOutMs: 500 })
  })

  // The pieces no longer agree: the first piece was made quieter after the
  // cut, the second kept +6 dB. Undoing the cut is refused then ("changed
  // since": it would throw that change away); the join throws nothing away
  // (the pieces stay), so it reads the pieces the one way: the first piece's
  // volume and fade-in, the last piece's fade-out — never the louder one.
  it("a piece's volume changed since the cut: the joined take has the first piece's volume, and the fades", async () => {
    const pieces = cutAt(1700)
    pieces[0] = { ...pieces[0], gainDb: -6 }
    takes["a.wav"].gainDb = -6
    const id = await joinTakePieces({ ...args, pieces })
    expect(levelOf(id)).toEqual({ gainDb: -6, fadeInMs: 300, fadeOutMs: 500 })
  })

  it("a cut stored the old way (the first piece holding all three, the second none): the take's level, as its Undo gives", async () => {
    const pieces: JoinPiece[] = [
      { audioId: "a.wav", url: URL_A, trimStartMs: null, trimEndMs: 1700, durationMs: 3400, gainDb: 6, fadeInMs: 300, fadeOutMs: 500 },
      { audioId: "b.wav", url: URL_A, trimStartMs: 1700, trimEndMs: null, durationMs: 3400 },
    ]
    const id = await joinTakePieces({ ...args, pieces })
    expect(levelOf(id)).toEqual({ gainDb: 6, fadeInMs: 300, fadeOutMs: 500 })
  })

  // Cut twice (at 1.0 s and 2.0 s), then the first piece deleted: the Recording
  // tab hands Join the two that are left. The joined take plays as they did:
  // the second piece's volume, no fade-in (the deleted piece held it), the
  // last piece's fade-out.
  it("the first piece deleted: the pieces left, as they played", async () => {
    const once = levelsAfterCut(TAKE, 2000)
    const twice = levelsAfterCut({ ...once.first, durationMs: 3400, trimEndMs: 2000 }, 1000)
    expect(twice.first.fadeInMs).toBe(300)
    const pieces: JoinPiece[] = [
      { audioId: "b.wav", url: URL_A, trimStartMs: 1000, trimEndMs: 2000, durationMs: 3400, ...twice.second },
      { audioId: "c.wav", url: URL_A, trimStartMs: 2000, trimEndMs: null, durationMs: 3400, ...once.second },
    ]
    const id = await joinTakePieces({ ...args, pieces })
    expect(levelOf(id)).toEqual({ gainDb: 6, fadeInMs: null, fadeOutMs: 500 })
  })

  it("a take with no volume or fades: no level is written", async () => {
    const id = await joinTakePieces({ ...args, pieces: cutAt(1700, { gainDb: null, fadeInMs: null, fadeOutMs: null, durationMs: 3400 }) })
    expect(events).toEqual([{ kind: "attach", audioId: id }])
    expect(painted[0].eventId).toBe(`ev-attach-${id}`)
  })

  // The level is its own write, after the attach (AQU-2525's field). When that
  // write fails, the attach is already queued: the caller hears of it, but
  // the bytes stay — `onEmitFailed` is only for an attach that was not queued.
  it("a level write that fails: the error reaches the caller, and the bytes are not given up", async () => {
    vi.mocked(emitCellAudioGain).mockRejectedValueOnce(new Error("idb write failed"))
    const onEmitFailed = vi.fn()
    await expect(attachUploadedTake({
      projectId: "p1", fileId: "f1", cellId: "c1", audioId: "j.wav", url: URL_A, slot: "recording",
      mimeType: "audio/wav", durationMs: 3400, surface: "recording-tab", username: "dev",
      level: { gainDb: 6, fadeInMs: 300, fadeOutMs: 500 }, onEmitFailed,
    })).rejects.toThrow("idb write failed")
    expect(onEmitFailed).not.toHaveBeenCalled()
  })
})

// The join's Undo step is a take added (AQU-2492 records it with the take in
// pieces as `selectedBefore`): Undo takes the joined take away and plays the
// pieces again, Redo brings the joined take back.
describe("Undo and Redo of the Join", () => {
  function handlers() {
    return takeStepHandlers({
      readTake: (_c, id) => (takes[id] && !takes[id].isDeleted ? (takes[id] as unknown as CodexCellAttachment) : null),
      selectedIn: (_c, slot) => playing[slot] ?? null,
      select: async (_c, slot, id) => {
        if (id && takes[id]) takes[id].isDeleted = false
        playing[slot] = id
      },
      remove: async (_c, id) => {
        takes[id].isDeleted = true
        if (playing[takes[id].slot] === id) playing[takes[id].slot] = null
      },
      applyTrim: async () => {},
      applyPlace: async () => {},
      cut: async () => true,
      uncut: async () => {},
      newPieceId: () => "fresh",
      rename: async () => {},
    })
  }

  it("Undo plays the pieces again, each at its own level; Redo brings the joined take back at the take's", async () => {
    const pieces = cutAt(1700)
    const id = await joinTakePieces({ ...args, pieces })
    const step: TakeAddData = { cellId: "c1", audioId: id, slot: "recording", selectedBefore: "a.wav" }
    const h = handlers()
    expect(await h["take.add"].undo(step as never)).toEqual({ kind: "done" })
    expect(takes[id].isDeleted).toBe(true)
    expect(playing.recording).toBe("a.wav")
    expect(levelOf("a.wav")).toEqual({ gainDb: 6, fadeInMs: 300, fadeOutMs: null })
    expect(levelOf("b.wav")).toEqual({ gainDb: 6, fadeInMs: null, fadeOutMs: 500 })
    expect(await h["take.add"].redo(step as never)).toEqual({ kind: "done" })
    expect(takes[id].isDeleted).toBe(false)
    expect(playing.recording).toBe(id)
    expect(levelOf(id)).toEqual({ gainDb: 6, fadeInMs: 300, fadeOutMs: 500 })
  })
})
