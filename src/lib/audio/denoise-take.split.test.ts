// AQU-1767 (Sam, 2026-10-14): "Remove noise" on a split take cleans it and
// keeps the cuts.
import { describe, expect, it, vi } from "vitest"

const emitted = vi.hoisted(() => ({ events: [] as Array<{ kind: string; input: Record<string, unknown> }> }))
vi.mock("@/lib/sync/events-emit", () => ({
  emitCellAudioAttach: vi.fn(async (input: Record<string, unknown>) => {
    emitted.events.push({ kind: "attach", input })
    return `ev-${emitted.events.length}`
  }),
  emitCellAudioPlace: vi.fn(async (input: Record<string, unknown>) => {
    emitted.events.push({ kind: "place", input })
    return `ev-${emitted.events.length}`
  }),
}))
vi.mock("./upload", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchCellAudio: vi.fn(async () => new Uint8Array([1])),
  uploadCellAudio: vi.fn(async (a: { audioId: string; ext: string }) => ({ audioId: a.audioId, ext: a.ext, url: "frontier-audio://clean" })),
  deleteCellAudio: vi.fn(async () => {}),
}))
vi.mock("./decode-mono", () => ({ decodeToMono48k: vi.fn(async () => new Float32Array(8)) }))
vi.mock("./denoise", () => ({
  denoiseMono48k: vi.fn(async () => ({ blob: new Blob(["x"], { type: "audio/webm" }), durationMs: 4000, mimeType: "audio/webm" })),
}))
vi.mock("./bytes-cache", () => ({ audioCachePutBlob: vi.fn(async () => {}) }))

import { denoiseSplitTake } from "./denoise-take"
import type { AudioAttachmentOut } from "@/lib/sync/cell-audio-read-types"

const piece = (audioId: string, over: Partial<AudioAttachmentOut>): AudioAttachmentOut => ({
  audioId, url: "frontier-audio://audio-c1-1.webm", slot: "trk-2", mimeType: null, voiceId: null,
  referenceAudioId: null, durationMs: 4000, trimStartMs: null, trimEndMs: null, ...over,
} as AudioAttachmentOut)

describe("denoiseSplitTake", () => {
  it("cleans once and rebuilds the same pieces, in place, on the take's own track", async () => {
    emitted.events = []
    const out = await denoiseSplitTake({
      projectId: "p", fileId: "f", cellId: "c1", author: "sam",
      session: { jwt: "j", username: "sam", createdAt: "" },
      pieces: [
        piece("audio-c1-1.webm", { trimEndMs: 1500, label: "Take 1 · 1" }),
        piece("audio-c1-2.webm", { trimStartMs: 1500, label: "Take 1 · 2", pieceOf: "audio-c1-1.webm", targetOffsetMs: 900 }),
      ],
    })
    const attaches = emitted.events.filter((e) => e.kind === "attach").map((e) => e.input)
    expect(attaches).toHaveLength(2)
    expect(attaches[0]).toMatchObject({
      audioId: out.audioId, url: "frontier-audio://clean", slot: "trk-2", trimEndMs: 1500,
      label: "Take 1 · 1", referenceAudioId: "audio-c1-1.webm",
    })
    expect(out.audioId.startsWith("dn-")).toBe(true)
    expect(attaches[0]).not.toHaveProperty("pieceOf")
    expect(attaches[1]).toMatchObject({
      url: "frontier-audio://clean", slot: "trk-2", trimStartMs: 1500, label: "Take 1 · 2",
      pieceOf: out.audioId, referenceAudioId: "audio-c1-2.webm",
    })
    // The second piece keeps its place on the timeline.
    const places = emitted.events.filter((e) => e.kind === "place").map((e) => e.input)
    expect(places).toEqual([expect.objectContaining({ audioId: attaches[1].audioId, targetOffsetMs: 900 })])
  })
})

// AQU-2267: a piece keeps its place in BOTH timings when it is cleaned — its
// place following the recordings is stated beside its place following the
// source, so neither timing sees it move.
describe("denoiseSplitTake — a piece's place in both timings (AQU-2267)", () => {
  it("re-places each moved piece in both timings, and paints both while it saves", async () => {
    emitted.events = []
    await denoiseSplitTake({
      projectId: "p", fileId: "f", cellId: "c1", author: "sam",
      session: { jwt: "j", username: "sam", createdAt: "" },
      pieces: [
        piece("audio-c1-1.webm", { trimEndMs: 1500, label: "Take 1 · 1", targetOffsetMs: -800, recordingsOffsetMs: 200 }),
        piece("audio-c1-2.webm", { trimStartMs: 1500, label: "Take 1 · 2", pieceOf: "audio-c1-1.webm", targetOffsetMs: 900, recordingsOffsetMs: 1900 }),
      ],
    })
    const places = emitted.events.filter((e) => e.kind === "place").map((e) => e.input)
    expect(places).toEqual([
      expect.objectContaining({ targetOffsetMs: -800, recordingsOffsetMs: 200 }),
      expect.objectContaining({ targetOffsetMs: 900, recordingsOffsetMs: 1900 }),
    ])
  })

  it("a piece placed only following the recordings is re-placed too", async () => {
    emitted.events = []
    await denoiseSplitTake({
      projectId: "p", fileId: "f", cellId: "c1", author: "sam",
      session: { jwt: "j", username: "sam", createdAt: "" },
      pieces: [
        piece("audio-c1-1.webm", { trimEndMs: 1500, label: "Take 1 · 1" }),
        piece("audio-c1-2.webm", { trimStartMs: 1500, pieceOf: "audio-c1-1.webm", recordingsOffsetMs: 300 }),
      ],
    })
    const places = emitted.events.filter((e) => e.kind === "place").map((e) => e.input)
    expect(places).toEqual([expect.objectContaining({ targetOffsetMs: null, recordingsOffsetMs: 300 })])
  })
})
