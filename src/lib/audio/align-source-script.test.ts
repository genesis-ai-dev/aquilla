import { describe, expect, it, vi } from "vitest"
import { waitFor } from "@testing-library/react"
import type { TranscriptionResult } from "./transcribe"
import type { CellData } from "@/hooks/useCells"
import { alignChunks } from "./timings"
import { alignSourceScript } from "./align-source-script"
describe("source script alignment", () => {
  it("reports bounded matching limits without contacting an alignment service", async () => {
    const script = Array.from({ length: 2100 }, (_, index) => `word${index}`).join(" ")
    await expect(alignSourceScript({ script, cells: [],
      clipUrl: "frontier-audio://source.mp3", loadAudio: async () => new Uint8Array([1]),
      transcribe: async () => ({ text: script, chunks: [{ text: script, start: 0, end: 30 }] }),
    })).rejects.toThrow("shorter sections")
  })

  it("discards transcription results after cancellation", async () => {
    const controller = new AbortController()
    let finish!: (result: TranscriptionResult) => void
    const pending = new Promise<TranscriptionResult>(resolve => { finish = resolve })
    const transcribe = vi.fn(async () => pending)
    const operation = alignSourceScript({ script: "Supplied wording.", cells: [],
      clipUrl: "frontier-audio://source.mp3", signal: controller.signal,
      loadAudio: async () => new Uint8Array([1]), transcribe })
    await waitFor(() => expect(transcribe).toHaveBeenCalledTimes(1))
    controller.abort()
    finish({ text: "Different", chunks: [{ text: "Different", start: 0, end: 1 }] })
    await expect(operation).rejects.toMatchObject({ name: "AbortError" })
  })
  it("returns unmatched paragraphs for manual timing review", async () => {
    const result = await alignSourceScript({
      script: "Supplied wording.", cells: [], clipUrl: "frontier-audio://source.mp3",
      loadAudio: async () => new Uint8Array([4, 5, 6]),
      transcribe: async () => ({ text: "Different speech", chunks: [
        { text: "Different", start: 1, end: 2 },
        { text: "speech", start: 2, end: 3 },
      ] }),
    })
    expect(result.segments[0]).toMatchObject({ text: "Supplied wording.",
      start: null, end: null, confidence: 0, needsReview: true })
    expect(result.method).toBe("whisper-word-match")
  })
  it.each(["en", "en-US", "eng"])(
    "uses fresh Whisper timings with normalized language %s using the configured transcription provider", async language => {
    const bytes = new Uint8Array([1, 2, 3])
    const loadAudio = vi.fn(async () => bytes)
    const transcribe = vi.fn(async () => ({ text: "Hello world.", chunks: [
      { text: "Hello", start: 1, end: 1.5 },
      { text: "world", start: 1.6, end: 2 },
    ] }))
    const result = await alignSourceScript({ script: "Hello world.", cells: [],
      clipUrl: "frontier-audio://source.mp3", language,
      loadAudio, transcribe })
    expect(result.segments[0]).toMatchObject({ start: 1, end: 2, confidence: 1 })
    expect(loadAudio).toHaveBeenCalledTimes(1)
    expect(transcribe).toHaveBeenCalledWith(bytes, { language: "en" })
  })
  it("reuses matching source evidence without downloading or running another model", async () => {
    const audioId = "audio-file-9-1700000000-src1.mp3"
    const clipUrl = "frontier-audio://source.mp3"
    const loadAudio = vi.fn(async () => new Uint8Array())
    const transcribe = vi.fn(async () => ({ text: "", chunks: [] }))
    const result = await alignSourceScript({
      script: "Hello world.", clipUrl, loadAudio, transcribe,
      cells: [{
        id: "sec-1", fileId: "file-9", medium: "media", selectedAudioId: audioId,
        original: "Hello world.", translated: "", context: "", group: "",
        type: "text", status: "unvalidated", validationStatus: "none",
        activeValidators: [], validationHistory: [], history: [], threads: [],
        attachments: { [audioId]: { type: "audio", url: clipUrl, trimStartMs: 5000 } },
        audioTimings: { [audioId]: alignChunks([
          { text: "Hello", start: 0.1, end: 0.5 },
          { text: "world", start: 0.6, end: 1 },
        ], "Hello world.") },
      } as CellData],
    })
    expect(result.segments[0]).toMatchObject({
      text: "Hello world.", start: 5.1, end: 6, confidence: 1, needsReview: false,
    })
    expect(loadAudio).not.toHaveBeenCalled()
    expect(transcribe).not.toHaveBeenCalled()
  })
})
