import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// AQU-1681. WHY: a linked video's own sound is analysed WHILE it streams in —
// a minute at a time, never the whole episode in memory. Handing that clip to
// the upload path must not decode all of it a second time (the 420 MB whole-
// file decode the streaming exists to avoid), and the rows must come out of
// the speech that was found: tiled timing, tight trims, the stored copy on
// every row as the file's source audio. A cancel must reach the upload.

const emitted = vi.hoisted(() => ({
  creates: [] as Array<Record<string, unknown>>,
  attaches: [] as Array<Record<string, unknown>>,
  uploadSignals: [] as Array<AbortSignal | undefined>,
}))

vi.mock("@/lib/sync/events-emit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sync/events-emit")>()
  return {
    ...actual,
    emitSourceCellCreate: vi.fn(async (input: Record<string, unknown>) => {
      emitted.creates.push(input)
      return "evt"
    }),
    emitCellAudioAttach: vi.fn(async (input: Record<string, unknown>) => {
      emitted.attaches.push(input)
      return "evt"
    }),
  }
})

vi.mock("@/lib/import", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/import")>()
  return {
    ...actual,
    computeMediaSegmentSpecs: vi.fn(async () => {
      throw new Error("the clip must not be decoded again")
    }),
  }
})

vi.mock("@/lib/audio/upload", () => ({
  buildAudioId: (id: string) => `${id}-clip`,
  uploadCellAudio: vi.fn(async (args: { signal?: AbortSignal }) => {
    emitted.uploadSignals.push(args.signal)
    return { audioId: "f1-clip", url: "frontier-audio://f1-clip.m4a", ext: "m4a" }
  }),
  deleteCellAudio: vi.fn(async () => {}),
}))

vi.mock("@/lib/audio/auto-transcribe", () => ({
  recordMediaImportSeed: vi.fn(),
  buildMediaSeedCells: vi.fn(() => []),
}))

import { attachMediaFileToTimeline, type AttachMediaContext } from "./attach-media"
import { setCqrsOutboxBridge } from "@/lib/sync/cqrs-bridge"
import { ROLE } from "@/lib/frontier/roles"
import { hasSharedClipPcm, releaseSharedClipPcm } from "@/lib/audio/shared-clip-pcm"

const ctx: AttachMediaContext = { projectId: "p1", fileId: "f1", author: "maint", getToken: async () => "tok" }

beforeEach(() => {
  emitted.creates.length = 0
  emitted.attaches.length = 0
  emitted.uploadSignals.length = 0
  setCqrsOutboxBridge({ projectId: "p1", activeFileId: "f1", username: "u", roleLevel: ROLE.MAINTAINER })
})

afterEach(() => {
  setCqrsOutboxBridge(null)
})

describe("attachMediaFileToTimeline with speech already found", () => {
  it("makes the rows from that speech without decoding the clip, and stores the copy on each", async () => {
    const file = new File([new Uint8Array(32)], "Episode 1 (English).m4a", { type: "audio/mp4" })
    const ac = new AbortController()
    const phases: string[] = []
    const result = await attachMediaFileToTimeline(file, ctx, {
      analysis: {
        durationMs: 8000,
        segments: [
          { startMs: 0, endMs: 2050 },
          { startMs: 2950, endMs: 4050 },
          { startMs: 5950, endMs: 8000 },
        ],
      },
      signal: ac.signal,
      onPhase: (phase) => phases.push(phase),
    })
    expect(result).toEqual({ segments: 3 })
    expect(phases).toEqual(["save", "rows"])
    expect(emitted.uploadSignals).toEqual([ac.signal])
    // Timing tiles the whole film; trims stay on the speech.
    expect(emitted.creates.map((c) => [c.startMs, c.endMs])).toEqual([[0, 2950], [2950, 5950], [5950, 8000]])
    expect(emitted.attaches.map((a) => [a.trimStartMs, a.trimEndMs])).toEqual([[0, 2050], [2950, 4050], [5950, 8000]])
    for (const a of emitted.attaches) {
      expect(a).toMatchObject({ url: "frontier-audio://f1-clip.m4a", role: "source", slot: "recording", durationMs: 8000, mimeType: "audio/mp4" })
    }
  })

  it("hands the sound's 16 kHz PCM to transcription under the stored copy's name", async () => {
    const file = new File([new Uint8Array(32)], "Episode 1 (English).m4a", { type: "audio/mp4" })
    await attachMediaFileToTimeline(file, ctx, {
      analysis: { durationMs: 8000, segments: [{ startMs: 0, endMs: 2050 }, { startMs: 2950, endMs: 4050 }], pcm16k: new Float32Array(8 * 16_000) },
    })
    expect(hasSharedClipPcm("f1-clip.m4a")).toBe(true)
    releaseSharedClipPcm()
  })
})
