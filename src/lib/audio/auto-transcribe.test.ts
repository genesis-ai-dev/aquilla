// AQU-646: post-import auto-transcription — seed lifecycle, seed-cell
// synthesis, and the single up-front consent gate.

import { describe, it, expect, vi, beforeEach } from "vitest"

const requestAiModelConsent = vi.fn(async (_model: unknown) => true)
vi.mock("./ai-consent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ai-consent")>()
  return { ...actual, requestAiModelConsent: (m: unknown) => requestAiModelConsent(m) }
})
const runTranscribeAll = vi.fn(async (_args: unknown) => {})
vi.mock("./batch-audio", () => ({
  runTranscribeAll: (a: unknown) => runTranscribeAll(a),
}))

import {
  recordMediaImportSeed,
  consumeMediaImportSeed,
  buildMediaSeedCells,
  autoTranscribeImportedMedia,
} from "./auto-transcribe"

beforeEach(() => {
  requestAiModelConsent.mockClear()
  requestAiModelConsent.mockResolvedValue(true)
  runTranscribeAll.mockClear()
})

describe("seed registry", () => {
  it("consume is delete-on-read (one auto-run per import)", () => {
    recordMediaImportSeed({ fileId: "fa", cells: [] })
    expect(consumeMediaImportSeed("fa")).toBeDefined()
    expect(consumeMediaImportSeed("fa")).toBeUndefined()
  })

  it("caps retained seeds (abandoned ones age out)", () => {
    for (let i = 0; i < 12; i++) recordMediaImportSeed({ fileId: `f${i}`, cells: [] })
    expect(consumeMediaImportSeed("f0")).toBeUndefined() // aged out
    expect(consumeMediaImportSeed("f11")).toBeDefined()
  })
})

describe("buildMediaSeedCells", () => {
  it("synthesizes exactly what transcribeCell + needsTranscription read", () => {
    const cells = buildMediaSeedCells({
      fileId: "f1",
      fileName: "episode.mp3",
      specs: [
        { cellId: "c1", startMs: 0, endMs: 5_000, trimStartMs: 300, trimEndMs: 4_200 },
        { cellId: "c2", startMs: 5_000, endMs: 9_000, trimStartMs: 5_000, trimEndMs: 8_800 },
      ],
      audioId: "audio-x.mp3",
      url: "frontier-audio://audio-x.mp3",
      durationMs: 9_000,
    })
    expect(cells).toHaveLength(2)
    const c = cells[0]
    expect(c.id).toBe("c1")
    expect(c.fileId).toBe("f1")
    expect(c.medium).toBe("media")
    expect(c.selectedAudioId).toBe("audio-x.mp3")
    expect(c.attachments?.["audio-x.mp3"]).toMatchObject({
      url: "frontier-audio://audio-x.mp3",
      trimStartMs: 300,
      trimEndMs: 4_200,
      durationMs: 9_000,
    })
    expect(c.startTime).toBe(0)
    expect(c.endTime).toBe(5)
  })
})

describe("autoTranscribeImportedMedia", () => {
  const seed = { fileId: "f1", cells: buildMediaSeedCells({
    fileId: "f1", fileName: "a.mp3",
    specs: [{ cellId: "c1", startMs: 0, endMs: 1_000 }],
    audioId: "a.mp3", url: "frontier-audio://a.mp3",
  }) }

  it("consent granted → runs the batch once with the seed cells + languages", async () => {
    await autoTranscribeImportedMedia({
      seed, projectId: "p1", session: null, sourceLanguage: "fra", targetLanguage: "spa",
    })
    expect(requestAiModelConsent).toHaveBeenCalledTimes(1)
    expect(runTranscribeAll).toHaveBeenCalledTimes(1)
    expect((runTranscribeAll.mock.calls[0] as unknown[])[0]).toMatchObject({
      cells: seed.cells,
      projectId: "p1",
      sourceLanguage: "fra",
      targetLanguage: "spa",
    })
  })

  it("consent denied → no batch, resolves without throwing", async () => {
    requestAiModelConsent.mockResolvedValue(false)
    await expect(
      autoTranscribeImportedMedia({ seed, projectId: "p1", session: null }),
    ).resolves.toBeUndefined()
    expect(runTranscribeAll).not.toHaveBeenCalled()
  })

  it("awaits onDone after the batch", async () => {
    const order: string[] = []
    runTranscribeAll.mockImplementation(async () => { order.push("batch") })
    await autoTranscribeImportedMedia({
      seed, projectId: "p1", session: null,
      onDone: async () => { order.push("done") },
    })
    expect(order).toEqual(["batch", "done"])
  })

  it("a batch failure is swallowed (import UX never breaks)", async () => {
    runTranscribeAll.mockRejectedValue(new Error("boom"))
    await expect(
      autoTranscribeImportedMedia({ seed, projectId: "p1", session: null }),
    ).resolves.toBeUndefined()
  })
})
