// AQU-646: post-import auto-transcription — seed lifecycle, seed-cell
// synthesis, and the single up-front consent gate.

import { setTranscriptionProvider } from "./transcription-preference"
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { setTranscribeStatus, clearTranscribeStatus } from "./transcribe-status"

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
  localStorage.clear()
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

  it("signed-in hosted transcription needs no local model consent", async () => {
    await autoTranscribeImportedMedia({
      seed, projectId: "p1",
      session: { jwt: "jwt", username: "dev", createdAt: "2026-09-30" },
    })
    expect(requestAiModelConsent).not.toHaveBeenCalled()
    expect(runTranscribeAll).toHaveBeenCalledOnce()
  })

  it("signed-in local choice requires consent and skips a denied batch", async () => {
    setTranscriptionProvider("dev", "local")
    requestAiModelConsent.mockResolvedValue(false)
    await autoTranscribeImportedMedia({
      seed, projectId: "p1",
      session: { jwt: "jwt", username: "dev", createdAt: "2026-09-30" },
    })
    expect(requestAiModelConsent).toHaveBeenCalledOnce()
    expect(runTranscribeAll).not.toHaveBeenCalled()
  })

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

  // AQU-1681: the hosted limit can pause a long run for a quarter of an hour;
  // the workspace's progress toast has to hear about it to say so.
  it("tells the caller when the transcription limit pauses the run", async () => {
    runTranscribeAll.mockImplementation(async (a: unknown) => {
      const args = a as { onWaiting?: (until: number | null) => void }
      args.onWaiting?.(1_700_000_000_000)
      args.onWaiting?.(null)
    })
    const onWaiting = vi.fn()
    await autoTranscribeImportedMedia({ seed, projectId: "p1", session: null, onWaiting })
    expect(onWaiting.mock.calls).toEqual([[1_700_000_000_000], [null]])
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

// ── The "it's working, wait" toast (Sam, 2026-08-18) ─────────────────────
//
// "There should be a toast that shows that it's loading." The toast itself
// lives in the workspace; what has to be true HERE is that the progress
// reaches it — and, just as important, that it stays quiet for the two runs
// that never happen, so nothing leaves a spinner up over no work at all.

describe("reporting progress to whoever is showing it", () => {
  const seed = { fileId: "f1", cells: [] }

  it("passes the reporter through to the batch", async () => {
    const onProgress = vi.fn()
    await autoTranscribeImportedMedia({ seed, projectId: "p1", session: null, onProgress })
    expect(runTranscribeAll).toHaveBeenCalledWith(expect.objectContaining({ onProgress }))
  })

  it("says nothing when consent is refused", async () => {
    // The toast is created lazily on the first report, so silence here is what
    // keeps a denied run from leaving a spinner on screen forever.
    requestAiModelConsent.mockResolvedValue(false)
    const onProgress = vi.fn()
    const onFailed = vi.fn()
    await autoTranscribeImportedMedia({ seed, projectId: "p1", session: null, onProgress, onFailed })
    expect(onProgress).not.toHaveBeenCalled()
    expect(onFailed).not.toHaveBeenCalled()
    expect(runTranscribeAll).not.toHaveBeenCalled()
  })

  it("reports a failure so the spinner can be taken back down", async () => {
    runTranscribeAll.mockRejectedValueOnce(new Error("model fetch failed"))
    const onFailed = vi.fn()
    const onDone = vi.fn()
    await autoTranscribeImportedMedia({ seed, projectId: "p1", session: null, onFailed, onDone })
    expect(onFailed).toHaveBeenCalledWith("model fetch failed")
    // Still never throws — a failed transcribe leaves the file exactly as a
    // manual-transcribe user would find it.
    expect(onDone).not.toHaveBeenCalled()
  })
})

// ── AQU-1917: a run the ASR backend rejected must not report success ──────
//
// `transcribeCell` catches a failed ASR call, records the error on the clip's
// status and RESOLVES, so `runTranscribeAll` never throws for it. The
// post-import report used to treat that as a completed run and say
// "Transcribed N sections of …" over a file that had gained no text at all.

describe("a run the backend rejected is reported as a failure, not a success", () => {
  const seed = { fileId: "f3", cells: buildMediaSeedCells({
    fileId: "f3", fileName: "c.mp3",
    specs: [{ cellId: "c1", startMs: 0, endMs: 1_000 }],
    audioId: "c.mp3", url: "frontier-audio://c.mp3",
  }) }

  afterEach(() => clearTranscribeStatus("c.mp3"))

  it("routes a batch that left an error to onFailed, and never to onDone", async () => {
    runTranscribeAll.mockImplementation(async () => {
      setTranscribeStatus("c.mp3", { kind: "error", message: "HTTP 500" })
    })
    const onDone = vi.fn()
    const onFailed = vi.fn()
    await autoTranscribeImportedMedia({ seed, projectId: "p1", session: null, onDone, onFailed })
    expect(onFailed).toHaveBeenCalledWith("HTTP 500")
    expect(onDone).not.toHaveBeenCalled()
  })

  it("still reports a real run through onDone", async () => {
    runTranscribeAll.mockImplementation(async () => {
      setTranscribeStatus("c.mp3", { kind: "done", wordCount: 3, durationMs: 10 })
    })
    const onDone = vi.fn()
    const onFailed = vi.fn()
    await autoTranscribeImportedMedia({ seed, projectId: "p1", session: null, onDone, onFailed })
    expect(onDone).toHaveBeenCalledTimes(1)
    expect(onFailed).not.toHaveBeenCalled()
  })
})
