// AQU-981 pins the one-file upload: bulk upload now shares its attach half
// (`attachUploadedTake`), and the one-file path must write exactly the take it
// always wrote.
import { beforeEach, describe, expect, it, vi } from "vitest"

const calls: string[] = []
const emitted: Array<Record<string, unknown>> = []
const injected: Array<unknown[]> = []
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
}))
vi.mock("@/lib/audio/audio-attachments-bus", () => ({
  injectOptimisticAudioAttachment: vi.fn((...args: unknown[]) => { calls.push("inject"); injected.push(args) }),
  notifyAudioAttachmentsChanged: vi.fn(() => { calls.push("notify") }),
}))
vi.mock("@/lib/audio/sync-token-fetcher", () => ({ audioSyncTokenFetcherForSession: () => async () => "token" }))
vi.mock("@/lib/audio/project-audio-state", () => ({ markProjectHasAudioDataSoon: vi.fn() }))
vi.mock("@/lib/import", () => ({ probeDurationMsSafe: vi.fn(async () => 1234.5) }))

import { ACCEPT, attachAudioFileToCell, validateAudioFile } from "./attach-file"

const session = { jwt: "jwt", username: "dev", createdAt: "" } as never

beforeEach(() => {
  calls.length = 0
  emitted.length = 0
  injected.length = 0
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
