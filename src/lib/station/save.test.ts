import { beforeEach, describe, expect, it, vi } from "vitest"

const calls = vi.hoisted(() => ({ attach: [] as unknown[], place: [] as unknown[], remove: [] as unknown[] }))
vi.mock("@/lib/audio/upload", () => ({
  buildAudioId: (seed: string) => `audio-${seed}`,
  uploadCellAudio: vi.fn(async (a: { audioId: string }) => ({ audioId: a.audioId, ext: "wav", url: `frontier-audio://${a.audioId}.wav` })),
  deleteCellAudio: vi.fn(async () => {}),
}))
vi.mock("@/lib/audio/bytes-cache", () => ({ audioCachePutBlob: vi.fn(async () => {}) }))
vi.mock("@/lib/audio/audio-attachments-bus", () => ({ injectOptimisticAudioAttachment: vi.fn(), notifyAudioAttachmentsChanged: vi.fn() }))
vi.mock("@/lib/sync/events-emit", () => ({
  emitCellAudioAttach: vi.fn(async (x: unknown) => (calls.attach.push(x), "ev")),
  emitCellAudioPlace: vi.fn(async (x: unknown) => (calls.place.push(x), "ev")),
  emitCellAudioRemove: vi.fn(async (x: unknown) => (calls.remove.push(x), "ev")),
}))

import { saveStationVersion, type VersionPlacement } from "./save"

const base: VersionPlacement = {
  fileId: "f",
  cellId: "c331",
  fromAudioId: "t2.webm",
  slot: "recording",
  label: "Take 2",
  trimStartMs: null,
  trimEndMs: 2500,
  targetOffsetMs: 120,
  recordingsOffsetMs: null,
  selectedBefore: "t2.webm",
}

describe("Save as new version", () => {
  beforeEach(() => {
    calls.attach.length = 0
    calls.place.length = 0
    calls.remove.length = 0
  })

  it("attaches the new version on each line, pointing back at the take it replaces, keeping track, name, trim and place", async () => {
    const res = await saveStationVersion({
      projectId: "p",
      samples: new Float32Array(48000),
      rate: 48000,
      placements: [base, { ...base, cellId: "c316", fromAudioId: "t1.webm", trimEndMs: null, targetOffsetMs: null }],
      author: "ana",
      getSyncToken: async () => "jwt",
      where: { fileId: "f" },
    })
    expect(res.audioIds).toEqual(["audio-c331.wav", "audio-c316.wav"])
    expect(calls.attach[0]).toMatchObject({ cellId: "c331", referenceAudioId: "t2.webm", label: "Take 2", slot: "recording", trimEndMs: 2500, durationMs: 1000 })
    expect(calls.attach[1]).toMatchObject({ cellId: "c316", referenceAudioId: "t1.webm", url: "frontier-audio://audio-c331.wav" })
    expect(calls.place).toHaveLength(1)
    expect(calls.remove).toHaveLength(0)
  })

  it("replaces a piece of a split take in place, as a piece (Q6)", async () => {
    await saveStationVersion({
      projectId: "p",
      samples: new Float32Array(4800),
      rate: 48000,
      placements: [{ ...base, fromAudioId: "piece2.webm", pieceOf: "t3.webm" }],
      author: "ana",
      getSyncToken: async () => "jwt",
      where: { fileId: "f" },
    })
    expect(calls.attach[0]).toMatchObject({ pieceOf: "t3.webm" })
    expect(calls.remove[0]).toMatchObject({ audioId: "piece2.webm" })
  })
})
