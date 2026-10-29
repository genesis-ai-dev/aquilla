import { afterEach, describe, expect, it, vi } from "vitest"
import type { CellData } from "@/hooks/useCells"
import type { ProjectTtsSettings } from "@/lib/parsers/types"

// AQU-2125. WHY: "Split by speaker" used to cast every new row to its "Speaker N"
// voice one entry at a time and never put the speaker on the row, so a long
// episode filled the project's casting record line by line and could never be
// folded. Each row now carries its speaker as its character, and each speaker
// is cast once.

const creates = vi.hoisted(() => [] as Array<Record<string, unknown>>)

vi.mock("@/lib/sync/events-emit", () => ({
  emitSourceCellCreate: vi.fn(async (input: Record<string, unknown>) => {
    creates.push(input)
    return "evt"
  }),
  emitSourceCellDelete: vi.fn(async () => "evt"),
  emitCellAudioAttach: vi.fn(async () => "evt"),
}))
vi.mock("@/lib/sync/sync-worker-url", () => ({ syncWorkerHttpOrigin: () => "http://sync.test" }))

import { runDiarization } from "./run-diarization"
import { assignedCastVoiceId } from "@/lib/audio/voices"

afterEach(() => {
  creates.length = 0
  vi.unstubAllGlobals()
})

const mediaCell = {
  id: "m1",
  fileId: "f1",
  original: "episode.wav",
  translated: "",
  medium: "media",
  selectedAudioId: "f1-clip",
  attachments: { "f1-clip": { url: "frontier-audio://f1-clip.wav", type: "audio", durationMs: 12000 } },
} as unknown as CellData

describe("runDiarization casting", () => {
  it("names every new row with its speaker and casts each speaker once", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("/diarization/start")) return Response.json({ jobId: "j1" })
      return Response.json({
        status: "succeeded",
        turns: [
          { startMs: 0, endMs: 3000, speaker: 0 },
          { startMs: 3000, endMs: 6000, speaker: 1 },
          { startMs: 6000, endMs: 9000, speaker: 0 },
          { startMs: 9000, endMs: 12000, speaker: 1 },
        ],
      })
    }))
    const saveTts = vi.fn()
    const existing: ProjectTtsSettings = { castAssignments: { "other-file-line": "narrator" } }
    await runDiarization({
      projectId: "p1",
      fileId: "f1",
      author: "maint",
      cells: [mediaCell],
      getToken: async () => "tok",
      ttsSettings: existing,
      saveTts,
    })

    const names = creates.map((c) => (c.metadata as { cast_name?: string } | undefined)?.cast_name)
    expect(names).toHaveLength(4)
    expect(new Set(names).size).toBe(2)
    expect(names[0]).toBe(names[2])
    expect(names[1]).toBe(names[3])

    const saved = saveTts.mock.calls[0][0] as ProjectTtsSettings
    const keys = Object.keys(saved.castAssignments ?? {})
    expect(keys.filter((k) => k.startsWith("character:"))).toHaveLength(2)
    // Another file's casting survives; no row of this file has an entry of its own.
    expect(saved.castAssignments?.["other-file-line"]).toBe("narrator")
    expect(keys).toHaveLength(3)

    // Every row speaks with its speaker's voice through the character entry.
    for (const c of creates) {
      const subject = { id: String(c.cellId), metadata: c.metadata as Record<string, unknown> }
      const voiceId = assignedCastVoiceId(saved, subject)
      const voice = saved.voices?.find((v) => v.id === voiceId)
      expect(voice?.name).toBe((c.metadata as { cast_name: string }).cast_name)
    }
  })
})
