import { describe, expect, it, vi } from "vitest"

describe("generateAndAttachCellVoice routing", () => {
  it("omnivoice voice uses the server TTS path, not client synth", async () => {
    vi.resetModules()
    const synthCellTts = vi.fn(async () => ({
      audioId: "audio-tts-1", durationSeconds: 1.2,
      objectName: "audio-tts-1.wav", url: "frontier-audio://audio-tts-1.wav",
    }))
    const synthForCell = vi.fn(async () => new Blob(["x"], { type: "audio/wav" }))
    const emitAttach = vi.fn(async () => {})
    vi.doMock("@/lib/sync/tts", () => ({ synthesizeCellTts: synthCellTts }))
    vi.doMock("./tts", () => ({
      synthesizeForCell: synthForCell, setTtsStatus: vi.fn(),
      ttsStatusKey: (s: string) => s,
    }))
    vi.doMock("@/lib/sync/events-emit", () => ({ emitCellAudioAttach: emitAttach }))
    vi.doMock("./audio-attachments-bus", () => ({ notifyAudioAttachmentsChanged: vi.fn(), injectOptimisticAudioAttachment: vi.fn() }))
    vi.doMock("./sync-token-fetcher", () => ({ audioSyncTokenFetcherForSession: () => async () => "tok" }))
    vi.doMock("./upload", () => ({
      buildAudioId: () => "id", uploadCellAudio: vi.fn(),
      fetchCellAudio: vi.fn(async () => new ArrayBuffer(4)),
    }))
    vi.doMock("./voice-clone", () => ({ convertToCloneVoice: vi.fn() }))
    vi.doMock("./voices", () => ({
      resolveVoice: () => ({ id: "v", name: "N", provider: "omnivoice" }),
    }))
    const { generateAndAttachCellVoice } = await import("./generate-voice")
    await generateAndAttachCellVoice({
      projectId: "p", fileId: "f", cellId: "c", text: "hello",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      session: { jwt: "j", username: "u" } as any, username: "u",
      geminiContext: { targetLanguage: "es" },
    })
    expect(synthCellTts).toHaveBeenCalledTimes(1)
    expect(synthForCell).not.toHaveBeenCalled()
    expect(emitAttach).toHaveBeenCalledWith(
      expect.objectContaining({ audioId: "audio-tts-1.wav", slot: "generatedVoice", durationMs: 1200 }),
    )
  })

  const mockPlainTts = (opts: { canEncode: boolean }) => {
    vi.resetModules()
    const ttsBlob = new Blob(["wav-bytes"], { type: "audio/wav" })
    const upload = vi.fn(async (a: { audioId: string; ext: string }) => ({
      audioId: a.audioId, ext: a.ext,
      url: `frontier-audio://${a.audioId}.${a.ext}`, sizeBytes: 1,
    }))
    const sibling = vi.fn(async () => true)
    const emitAttach = vi.fn(async () => "evt-1")
    vi.doMock("@/lib/sync/tts", () => ({ synthesizeCellTts: vi.fn() }))
    vi.doMock("./tts", () => ({
      synthesizeForCell: vi.fn(async () => ttsBlob), setTtsStatus: vi.fn(),
      ttsStatusKey: (s: string) => s,
    }))
    vi.doMock("./voices", () => ({
      resolveVoice: () => ({ id: "v", name: "N", provider: "gemini" }),
    }))
    vi.doMock("./tts-providers", () => ({ resolveTtsProvider: () => "gemini" }))
    vi.doMock("./opus-encode", () => ({
      canEncodeOpus: () => opts.canEncode,
      encodeMonoToWebmOpus: vi.fn(async () => ({
        blob: new Blob(["opus"], { type: "audio/webm" }),
        mimeType: "audio/webm", ext: "webm", durationMs: 1234,
      })),
    }))
    vi.doMock("./decode-mono", () => ({
      decodeToMono48k: vi.fn(async () => new Float32Array(480)), TARGET_RATE: 48000,
    }))
    vi.doMock("./bytes-cache", () => ({ audioCachePutBlob: vi.fn(async () => {}) }))
    vi.doMock("./lossless-sibling", () => ({ uploadLosslessSiblingBestEffort: sibling }))
    vi.doMock("@/lib/sync/events-emit", () => ({ emitCellAudioAttach: emitAttach }))
    vi.doMock("./audio-attachments-bus", () => ({
      notifyAudioAttachmentsChanged: vi.fn(), injectOptimisticAudioAttachment: vi.fn(),
    }))
    vi.doMock("./sync-token-fetcher", () => ({ audioSyncTokenFetcherForSession: () => async () => "tok" }))
    vi.doMock("./upload", () => ({
      buildAudioId: () => "base-id", uploadCellAudio: upload,
      fetchCellAudio: vi.fn(async () => new ArrayBuffer(4)),
    }))
    vi.doMock("./voice-clone", () => ({ convertToCloneVoice: vi.fn() }))
    // The WAV-fallback path probes the blob's duration with a real media
    // element — which never resolves in jsdom.
    vi.doMock("@/lib/import", async (importActual) => ({
      ...(await importActual<Record<string, unknown>>()),
      probeDurationMsSafe: vi.fn(async () => 999),
    }))
    return { ttsBlob, upload, sibling, emitAttach }
  }

  it("plain TTS uploads compressed AND the lossless WAV sibling under the same id", async () => {
    const { ttsBlob, upload, sibling, emitAttach } = mockPlainTts({ canEncode: true })
    const { generateAndAttachCellVoice } = await import("./generate-voice")
    await generateAndAttachCellVoice({
      projectId: "p", fileId: "f", cellId: "c", text: "hello",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      session: { jwt: "j", username: "u" } as any, username: "u",
      geminiContext: { targetLanguage: "es" },
    })
    expect(upload).toHaveBeenCalledTimes(1)
    expect(upload).toHaveBeenCalledWith(expect.objectContaining({ audioId: "base-id", ext: "webm" }))
    expect(sibling).toHaveBeenCalledTimes(1)
    expect(sibling).toHaveBeenCalledWith(
      expect.objectContaining({ audioId: "base-id", wavBlob: ttsBlob }),
    )
    // The attach stays the COMPRESSED object — the sibling gets no row.
    expect(emitAttach).toHaveBeenCalledWith(
      expect.objectContaining({ audioId: "base-id.webm", mimeType: "audio/webm", durationMs: 1234 }),
    )
  })

  it("no WAV sibling when the encoder is unavailable — the primary IS the WAV", async () => {
    const { upload, sibling } = mockPlainTts({ canEncode: false })
    const { generateAndAttachCellVoice } = await import("./generate-voice")
    await generateAndAttachCellVoice({
      projectId: "p", fileId: "f", cellId: "c", text: "hello",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      session: { jwt: "j", username: "u" } as any, username: "u",
      geminiContext: { targetLanguage: "es" },
    })
    expect(upload).toHaveBeenCalledWith(expect.objectContaining({ audioId: "base-id", ext: "wav" }))
    expect(sibling).not.toHaveBeenCalled()
  })
})
