// AQU-981 pins the one-file upload: bulk upload now shares its attach half
// (`attachUploadedTake`), and the one-file path must write exactly the take it
// always wrote.
import { beforeEach, describe, expect, it, vi } from "vitest"

const calls: string[] = []
const emitted: Array<Record<string, unknown>> = []
const injected: Array<unknown[]> = []
const placed: Array<Record<string, unknown>> = []
let emitFails = false

vi.mock("@/lib/audio/upload", () => ({
  buildAudioId: (seed: string) => `audio-${seed}-1700000000000-abc`,
  uploadCellAudio: vi.fn(async (args: { audioId: string; ext: string }) => {
    calls.push("upload")
    return { audioId: args.audioId, ext: args.ext, url: `frontier-audio://${args.audioId}.${args.ext}`, sizeBytes: 10 }
  }),
  deleteCellAudio: vi.fn(async () => { calls.push("delete") }),
}))
vi.mock("@/lib/audio/bytes-cache", () => ({ audioCachePutBlob: vi.fn(async () => { calls.push("cache") }) }))
vi.mock("@/lib/sync/events-emit", () => ({
  emitCellAudioAttach: vi.fn(async (input: Record<string, unknown>) => {
    calls.push("emit")
    if (emitFails) throw new Error("outbox full")
    emitted.push(input)
    return "ev-1"
  }),
  emitCellAudioPlace: vi.fn(async (input: Record<string, unknown>) => {
    calls.push("place")
    placed.push(input)
    return "ev-place"
  }),
}))
vi.mock("@/lib/audio/audio-attachments-bus", () => ({
  injectOptimisticAudioAttachment: vi.fn((...args: unknown[]) => { calls.push("inject"); injected.push(args) }),
  notifyAudioAttachmentsChanged: vi.fn(() => { calls.push("notify") }),
}))
vi.mock("@/lib/audio/sync-token-fetcher", () => ({ audioSyncTokenFetcherForSession: () => async () => "token" }))
vi.mock("@/lib/audio/project-audio-state", () => ({ markProjectHasAudioDataSoon: vi.fn() }))
vi.mock("@/lib/import", () => ({ probeDurationMsSafe: vi.fn(async () => 1234.5) }))

import { ACCEPT, attachAudioFileToCell, attachUploadedTake, validateAudioFile } from "./attach-file"
import { bornTakePlace, keptTakePlace } from "./new-take-place"
import { targetChipGeom } from "@/lib/timeline/lane-timing"
import type { CellData } from "@/hooks/useCells"
import type { AudioAttachmentOut } from "@/lib/sync/cell-audio-read-types"

const session = { jwt: "jwt", username: "dev", createdAt: "" } as never

beforeEach(() => {
  calls.length = 0
  emitted.length = 0
  injected.length = 0
  placed.length = 0
  emitFails = false
})

describe("attachAudioFileToCell (the one-file upload)", () => {
  it("caches, uploads, attaches and paints the take in that order, with the same fields as ever", async () => {
    const file = new File([new Uint8Array(10)], "verse.wav", { type: "audio/wav" })
    const out = await attachAudioFileToCell({ session, projectId: "p1", fileId: "f1", cellId: "c1", file, username: "dev", targetLang: "za", surface: "cell" })
    expect(calls).toEqual(["cache", "upload", "emit", "inject", "notify"])
    expect(emitted).toEqual([{
      projectId: "p1",
      fileId: "f1",
      cellId: "c1",
      audioId: "audio-c1-1700000000000-abc.wav",
      url: "frontier-audio://audio-c1-1700000000000-abc.wav",
      slot: "recording",
      mimeType: "audio/wav",
      durationMs: 1234.5,
      label: undefined,
      targetLang: "za",
      audioOrigin: "attach",
      surface: "cell",
      author: "dev",
    }])
    expect(injected[0]).toEqual(["f1", "c1", {
      audioId: "audio-c1-1700000000000-abc.wav",
      url: "frontier-audio://audio-c1-1700000000000-abc.wav",
      slot: "recording",
      mimeType: "audio/wav",
      voiceId: null,
      referenceAudioId: null,
      durationMs: 1234.5,
      label: undefined,
      trimStartMs: null,
      trimEndMs: null,
    }, "ev-1"])
    expect(out).toEqual({ audioId: "audio-c1-1700000000000-abc.wav", url: "frontier-audio://audio-c1-1700000000000-abc.wav", durationMs: 1234.5 })
  })

  it("deletes the uploaded bytes when the attach cannot be queued, and says why", async () => {
    emitFails = true
    const file = new File([new Uint8Array(10)], "verse.wav", { type: "audio/wav" })
    await expect(attachAudioFileToCell({ session, projectId: "p1", fileId: "f1", cellId: "c1", file, username: "dev", surface: "cell" })).rejects.toThrow("outbox full")
    expect(calls).toEqual(["cache", "upload", "emit", "delete"])
  })
})

// AQU-2491 (review, Nov 9): a line recorded before AQU-2491 still holds the
// recorder's pre-roll as ITS place (-200 ms), and a take with no place of its
// own reads that one. An uploaded take is given its own place, the line's
// start, so it starts on its cue and not 0.2 s early.
describe("AQU-2491: an uploaded take sits on its line's start, whatever place the line holds", () => {
  const oldLine = { id: "c1", fileId: "f1", startTime: 10, endTime: 14, metadata: { target_offset_ms: -200 } } as unknown as CellData

  it("on a line with times, the take gets its own place 0 and starts on its cue", async () => {
    const file = new File([new Uint8Array(10)], "verse.wav", { type: "audio/wav" })
    await attachAudioFileToCell({ session, projectId: "p1", fileId: "f1", cellId: "c1", file, username: "dev", targetLang: "za", surface: "cell", place: bornTakePlace(oldLine) })
    expect(calls).toEqual(["cache", "upload", "emit", "place", "inject", "notify"])
    expect(placed).toEqual([{
      projectId: "p1", fileId: "f1", cellId: "c1", audioId: "audio-c1-1700000000000-abc.wav",
      targetOffsetMs: 0, recordingsOffsetMs: null, targetLang: "za", author: "dev",
    }])
    const painted = injected[0][2] as AudioAttachmentOut
    expect(painted.targetOffsetMs).toBe(0)
    // Drawn, played and exported on its cue (10 s), not at the line's 9.8 s.
    expect(targetChipGeom(oldLine, { durationMs: 1000, targetOffsetMs: painted.targetOffsetMs })!.start).toBe(10)
    // The overlay waits for the place, so the take never flashes early.
    expect(injected[0][3]).toBe("ev-place")
  })

  it("on a line with no times, nothing is placed, as before", async () => {
    const file = new File([new Uint8Array(10)], "verse.wav", { type: "audio/wav" })
    await attachAudioFileToCell({ session, projectId: "p1", fileId: "f1", cellId: "c1", file, username: "dev", surface: "cell", place: bornTakePlace({ startTime: undefined } as CellData) })
    expect(placed).toEqual([])
    expect((injected[0][2] as AudioAttachmentOut).targetOffsetMs).toBeUndefined()
  })

  it("a take made from another keeps that take's places in both timings", async () => {
    await attachUploadedTake({
      projectId: "p1", fileId: "f1", cellId: "c1", audioId: "audio-c1-2.wav", url: "frontier-audio://audio-c1-2.wav",
      slot: "recording", mimeType: "audio/wav", durationMs: 1000, surface: "recording-tab", username: "dev",
      place: keptTakePlace({ targetOffsetMs: -340, recordingsOffsetMs: 120 }),
    })
    expect(placed).toMatchObject([{ audioId: "audio-c1-2.wav", targetOffsetMs: -340, recordingsOffsetMs: 120 }])
    expect(injected[0][2]).toMatchObject({ targetOffsetMs: -340, recordingsOffsetMs: 120 })
  })
})

// AQU-1922 — "confirm the import dialog's accepted list against what actually
// decodes". It did not match in either direction: the picker refused to LIST
// six of the ten formats the validator accepts, and it ACCEPTED formats no
// browser can decode (they declare a real audio/* type, so the declared-type
// check waved them straight through and the take never played).
describe("validateAudioFile — the accepted list matches what decodes (AQU-1922)", () => {
  const file = (name: string, type: string) =>
    new File([new Uint8Array(10)], name, { type })

  it("offers every format it accepts, including the six it used to hide", () => {
    // The old literal was "audio/*,.wav,.mp3,.m4a,.ogg": a FLAC or Opus pick
    // off a phone's Files app (empty MIME) was unselectable in the dialog.
    for (const ext of ["wav", "mp3", "m4a", "mp4", "aac", "ogg", "oga", "opus", "webm", "flac"]) {
      expect(ACCEPT).toContain(`.${ext}`)
    }
  })

  it("accepts a supported format whose MIME type the OS does not report", () => {
    for (const name of ["verse.flac", "verse.opus", "verse.aac", "verse.webm", "verse.oga", "verse.mp4"]) {
      expect(validateAudioFile(file(name, ""))).toBeNull()
    }
  })

  it("refuses a format a browser cannot decode, even though it declares audio/*", () => {
    // Without the up-front extension check these passed on `audio/x-ms-wma`
    // alone, uploaded, and sat on the line as a take that never played — while
    // bulk upload refused the very same file as `unplayableFormat`.
    expect(validateAudioFile(file("verse.wma", "audio/x-ms-wma"))).toMatch(/can't be played in a browser/)
    expect(validateAudioFile(file("verse.aiff", "audio/aiff"))).toMatch(/\.aiff file/)
    expect(validateAudioFile(file("verse.amr", "audio/amr"))).toMatch(/can't be played in a browser/)
  })

  it("still refuses something that is not audio at all", () => {
    expect(validateAudioFile(file("notes.txt", "text/plain"))).toMatch(/doesn't look like an audio file/)
  })
})
