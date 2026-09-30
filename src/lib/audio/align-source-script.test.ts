import { describe, expect, it, vi } from "vitest"
import { waitFor } from "@testing-library/react"
import type { TranscriptionResult } from "./transcribe"
import type { CellData } from "@/hooks/useCells"
import { alignChunks } from "./timings"
import { alignSourceScript } from "./align-source-script"
import { runAcousticAlignment } from "./run-acoustic-alignment"

describe("acoustic alignment client", () => {
  it("polls scoped job state and validates the completed paragraphs", async () => {
    const result = { method: "ctc-forced-alignment", segments: [{
      text: "Known wording.", start: 1, end: 2, confidence: 0.9,
      matchedWords: 2, totalWords: 2, needsReview: false, status: "matched",
    }] }
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ jobId: "job", status: "running" }))
      .mockResolvedValueOnce(Response.json({ status: "running" }))
      .mockResolvedValueOnce(Response.json({ status: "done", result }))
    const getToken = vi.fn(async () => "scoped-token")
    const wait = vi.fn(async () => {})
    expect(await runAcousticAlignment({ projectId: "project", fileId: "media",
      clipUrl: "frontier-audio://clip.m4a", script: "Known wording.",
      language: "en", getToken, request, wait })).toEqual(result)
    expect(getToken).toHaveBeenCalledWith("media")
    expect(JSON.parse(request.mock.calls[0][1]!.body as string)).toMatchObject({
      audioObject: "clip.m4a", script: "Known wording.", language: "en",
    })
    expect(wait).toHaveBeenCalledTimes(1)
    expect(request.mock.calls[1][0]).toContain("/alignment/status?jobId=job")
  })

  it("rejects changed wording returned by the service", async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ jobId: "job" }))
      .mockResolvedValueOnce(Response.json({ status: "done", result: {
        method: "ctc-forced-alignment", segments: [{ text: "Changed", start: 1,
          end: 2, confidence: 0.9, matchedWords: 1, totalWords: 1,
          needsReview: false, status: "matched" }],
      } }))
    await expect(runAcousticAlignment({ projectId: "project", fileId: "media",
      clipUrl: "frontier-audio://clip.m4a", script: "Known wording.",
      language: "en", getToken: async () => "token", request,
    })).rejects.toThrow("Invalid acoustic alignment result")
  })

  it("cancels before starting paid model work", async () => {
    const controller = new AbortController()
    controller.abort()
    const request = vi.fn<typeof fetch>()
    await expect(runAcousticAlignment({ projectId: "project", fileId: "media",
      clipUrl: "frontier-audio://clip.m4a", script: "Known wording.",
      language: "en", getToken: async () => "token", request,
      signal: controller.signal,
    })).rejects.toMatchObject({ name: "AbortError" })
    expect(request).not.toHaveBeenCalled()
  })

  it("ends a stalled token request without starting model work afterward", async () => {
    vi.useFakeTimers()
    try {
      let finishToken!: (token: string) => void
      const token = new Promise<string>(resolve => { finishToken = resolve })
      const request = vi.fn<typeof fetch>()
      const operation = runAcousticAlignment({ projectId: "project", fileId: "media",
        clipUrl: "frontier-audio://clip.m4a", script: "Known wording.",
        language: "en", getToken: async () => token, request })
      const rejected = expect(operation).rejects.toThrow("request timed out")
      await vi.advanceTimersByTimeAsync(60_000)
      await rejected
      finishToken("late-token")
      await Promise.resolve()
      await Promise.resolve()
      expect(request).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it("cancels while a token request is still pending", async () => {
    const controller = new AbortController()
    const request = vi.fn<typeof fetch>()
    const operation = runAcousticAlignment({ projectId: "project", fileId: "media",
      clipUrl: "frontier-audio://clip.m4a", script: "Known wording.",
      language: "en", getToken: () => new Promise(() => {}), request,
      signal: controller.signal })
    controller.abort()
    await expect(operation).rejects.toMatchObject({ name: "AbortError" })
    expect(request).not.toHaveBeenCalled()
  })

  it("bounds a stalled response body as part of the request", async () => {
    vi.useFakeTimers()
    try {
      const response = Response.json({})
      vi.spyOn(response, "json").mockImplementation(() => new Promise(() => {}))
      const request = vi.fn<typeof fetch>().mockResolvedValue(response)
      const operation = runAcousticAlignment({ projectId: "project", fileId: "media",
        clipUrl: "frontier-audio://clip.m4a", script: "Known wording.",
        language: "en", getToken: async () => "token", request })
      const rejected = expect(operation).rejects.toThrow("request timed out")
      await vi.advanceTimersByTimeAsync(60_000)
      await rejected
      expect(request.mock.calls[0][1]?.signal?.aborted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("source script alignment", () => {
  it("falls back to acoustic alignment when word matching exceeds its bounded matrix", async () => {
    const script = Array.from({ length: 2100 }, (_, index) => `word${index}`).join(" ")
    const forceAlign = vi.fn(async () => ({ segments: [] }))
    await expect(alignSourceScript({ script, cells: [],
      clipUrl: "frontier-audio://source.mp3", loadAudio: async () => new Uint8Array([1]),
      transcribe: async () => ({ text: script, chunks: [{ text: script, start: 0, end: 30 }] }),
      forceAlign,
    })).resolves.toMatchObject({ method: "ctc-forced-alignment" })
    expect(forceAlign).toHaveBeenCalledTimes(1)
  })

  it("does not start acoustic alignment after cancellation during transcription", async () => {
    const controller = new AbortController()
    let finish!: (result: TranscriptionResult) => void
    const pending = new Promise<TranscriptionResult>(resolve => { finish = resolve })
    const transcribe = vi.fn(async () => pending)
    const forceAlign = vi.fn(async () => ({ segments: [] }))
    const operation = alignSourceScript({ script: "Supplied wording.", cells: [],
      clipUrl: "frontier-audio://source.mp3", signal: controller.signal,
      loadAudio: async () => new Uint8Array([1]), transcribe, forceAlign })
    await waitFor(() => expect(transcribe).toHaveBeenCalledTimes(1))
    controller.abort()
    finish({ text: "Different", chunks: [{ text: "Different", start: 0, end: 1 }] })
    await expect(operation).rejects.toMatchObject({ name: "AbortError" })
    expect(forceAlign).not.toHaveBeenCalled()
  })
  it("uses acoustic alignment when Whisper cannot match the supplied wording", async () => {
    const bytes = new Uint8Array([4, 5, 6])
    const signal = new AbortController().signal
    const acoustic = { segments: [{ text: "Supplied wording.",
      start: 1, end: 3, confidence: 0.8, matchedWords: 2, totalWords: 2,
      needsReview: true, status: "partial" as const }] }
    const forceAlign = vi.fn(async () => acoustic)
    const result = await alignSourceScript({
      script: "Supplied wording.", cells: [], clipUrl: "frontier-audio://source.mp3",
      signal, loadAudio: async () => bytes,
      transcribe: async () => ({ text: "Different speech", chunks: [
        { text: "Different", start: 1, end: 2 },
        { text: "speech", start: 2, end: 3 },
      ] }), forceAlign,
    })
    expect(forceAlign).toHaveBeenCalledWith("Supplied wording.", bytes, signal)
    expect(result.segments).toBe(acoustic.segments)
    expect(result.method).toBe("ctc-forced-alignment")
  })
  it.each(["en", "en-US", "eng"])(
    "uses fresh Whisper timings with normalized language %s before acoustic fallback", async language => {
    const bytes = new Uint8Array([1, 2, 3])
    const loadAudio = vi.fn(async () => bytes)
    const transcribe = vi.fn(async () => ({ text: "Hello world.", chunks: [
      { text: "Hello", start: 1, end: 1.5 },
      { text: "world", start: 1.6, end: 2 },
    ] }))
    const forceAlign = vi.fn(async () => ({ segments: [] }))
    const result = await alignSourceScript({ script: "Hello world.", cells: [],
      clipUrl: "frontier-audio://source.mp3", language,
      loadAudio, transcribe, forceAlign })
    expect(result.segments[0]).toMatchObject({ start: 1, end: 2, confidence: 1 })
    expect(loadAudio).toHaveBeenCalledTimes(1)
    expect(transcribe).toHaveBeenCalledWith(bytes, { language: "en" })
    expect(forceAlign).not.toHaveBeenCalled()
  })
  it("reuses matching source evidence without downloading or running another model", async () => {
    const audioId = "audio-file-9-1700000000-src1.mp3"
    const clipUrl = "frontier-audio://source.mp3"
    const loadAudio = vi.fn(async () => new Uint8Array())
    const transcribe = vi.fn(async () => ({ text: "", chunks: [] }))
    const forceAlign = vi.fn(async () => ({ segments: [] }))
    const result = await alignSourceScript({
      script: "Hello world.", clipUrl, loadAudio, transcribe, forceAlign,
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
    expect(forceAlign).not.toHaveBeenCalled()
  })
})
