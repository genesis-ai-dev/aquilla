// AQU-2494 (review, Nov 9): a Station save is the same performance edited, so
// the new version keeps the marks the take had. On an added track an AI voice
// is known only by the voice it was made with: the saved version lost it, so
// its sparkle went and it counted as a person's recording.
import { beforeEach, describe, expect, it, vi } from "vitest"

const calls = vi.hoisted(() => ({ attach: [] as Record<string, unknown>[], painted: [] as Record<string, unknown>[] }))
vi.mock("@/lib/audio/upload", () => ({
  buildAudioId: (seed: string) => `audio-${seed}`,
  uploadCellAudio: vi.fn(async (a: { audioId: string }) => ({ audioId: a.audioId, ext: "wav", url: `frontier-audio://${a.audioId}.wav` })),
  deleteCellAudio: vi.fn(async () => {}),
}))
vi.mock("@/lib/audio/bytes-cache", () => ({ audioCachePutBlob: vi.fn(async () => {}) }))
vi.mock("@/lib/audio/audio-attachments-bus", () => ({
  injectOptimisticAudioAttachment: vi.fn((_f: string, _c: string, att: Record<string, unknown>) => { calls.painted.push(att) }),
  notifyAudioAttachmentsChanged: vi.fn(),
}))
vi.mock("@/lib/sync/events-emit", () => ({
  emitCellAudioAttach: vi.fn(async (x: Record<string, unknown>) => (calls.attach.push(x), "ev")),
  emitCellAudioPlace: vi.fn(async () => "ev"),
  emitCellAudioGain: vi.fn(async () => "ev"),
  emitCellAudioRemove: vi.fn(async () => "ev"),
}))

import { saveStationVersion, type VersionPlacement } from "./save"

const placement: VersionPlacement = {
  fileId: "f",
  cellId: "c331",
  fromAudioId: "t2.webm",
  slot: "track-2",
  label: "Take 2",
  trimStartMs: null,
  trimEndMs: null,
  targetOffsetMs: null,
  recordingsOffsetMs: null,
  selectedBefore: "t2.webm",
}
const save = (placements: VersionPlacement[]) =>
  saveStationVersion({ projectId: "p", samples: new Float32Array(4800), rate: 48000, placements, author: "ana", getSyncToken: async () => "jwt", where: { fileId: "f" }, mode: "over" })

describe("a Station save keeps the take's AI-voice mark", () => {
  beforeEach(() => {
    calls.attach.length = 0
    calls.painted.length = 0
  })

  it("the new version of an AI voice on an added track is still that voice, on every line", async () => {
    await save([{ ...placement, voiceId: "v-ana" }, { ...placement, cellId: "c316", fromAudioId: "t1.webm", voiceId: "v-ana" }])
    expect(calls.attach.map((a) => a.voiceId)).toEqual(["v-ana", "v-ana"])
    expect(calls.painted.map((a) => a.voiceId)).toEqual(["v-ana", "v-ana"])
  })

  it("a person's take stays a person's take", async () => {
    await save([placement])
    expect(calls.attach[0]).not.toHaveProperty("voiceId")
    expect(calls.painted[0]).toMatchObject({ voiceId: null })
  })
})
