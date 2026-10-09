import { afterEach, describe, expect, it, vi } from "vitest"
import type { CellData } from "@/hooks/useCells"

// AQU-1565 follow-up. WHY: "Split by speaker" deletes the file's media rows and
// re-attaches the SAME shared recording to each new row with a trim window.
// That clip is the file's source audio; re-attached without the role it was
// stored as a dub on every new row (a mic on each line, "recorded 100%").

const attaches = vi.hoisted(() => [] as Array<Record<string, unknown>>)

vi.mock("@/lib/sync/events-emit", () => ({
  emitSourceCellCreate: vi.fn(async () => "evt"),
  emitSourceCellDelete: vi.fn(async () => "evt"),
  emitCellAudioAttach: vi.fn(async (input: Record<string, unknown>) => {
    attaches.push(input)
    return "evt"
  }),
}))
vi.mock("@/lib/sync/sync-worker-url", () => ({ syncWorkerHttpOrigin: () => "http://sync.test" }))
vi.mock("@/lib/audio/reference-extract", () => ({ extractVoiceReference: vi.fn(async () => null) }))

import { runDiarization } from "./run-diarization"

afterEach(() => {
  attaches.length = 0
  vi.unstubAllGlobals()
})

const mediaCell = {
  id: "m1",
  fileId: "f1",
  original: "episode.wav",
  translated: "",
  medium: "media",
  selectedAudioId: "f1-clip",
  attachments: { "f1-clip": { url: "frontier-audio://f1-clip.wav", type: "audio", durationMs: 9000 } },
} as unknown as CellData

describe("runDiarization", () => {
  it("re-attaches the shared recording to every new row as source audio", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("/diarization/start")) return Response.json({ jobId: "j1" })
      return Response.json({
        status: "succeeded",
        turns: [
          { startMs: 0, endMs: 3000, speaker: 0 },
          { startMs: 3000, endMs: 6000, speaker: 1 },
        ],
      })
    }))
    const result = await runDiarization({
      projectId: "p1",
      fileId: "f1",
      author: "maint",
      cells: [mediaCell],
      getToken: async () => "tok",
      ttsSettings: undefined,
      saveTts: vi.fn(),
    })
    expect(result.segments).toBe(2)
    expect(attaches).toHaveLength(2)
    for (const a of attaches) {
      expect(a).toMatchObject({ audioId: "f1-clip", slot: "recording", role: "source" })
    }
  })
})
