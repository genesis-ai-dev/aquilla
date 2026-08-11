import { describe, expect, it, vi } from "vitest"

describe("generateCombinedVoice routing", () => {
  it("omnivoice voice uses server TTS path and attaches to all cells", async () => {
    vi.resetModules()
    const synthCellTts = vi.fn(async () => ({
      audioId: "a", durationSeconds: 1,
      objectName: "a.wav", url: "frontier-audio://a.wav",
    }))
    const synthForCell = vi.fn(async () => new Blob(["x"], { type: "audio/wav" }))
    const emitAttach = vi.fn(async () => {})
    vi.doMock("@/lib/sync/tts", () => ({ synthesizeCellTts: synthCellTts }))
    vi.doMock("./tts", () => ({
      synthesizeForCell: synthForCell,
      setTtsStatus: vi.fn(),
      ttsStatusKey: (s: string) => s,
    }))
    vi.doMock("./voices", () => ({
      resolveCastVoice: () => ({ id: "v", name: "N", provider: "omnivoice" }),
    }))
    vi.doMock("./upload", () => ({
      buildAudioId: () => "id",
      uploadCellAudio: vi.fn(),
      fetchCellAudio: vi.fn(async () => new ArrayBuffer(4)),
    }))
    vi.doMock("./sync-token-fetcher", () => ({
      audioSyncTokenFetcherForSession: () => async () => "tok",
    }))
    vi.doMock("./voice-clone", () => ({ convertToCloneVoice: vi.fn() }))
    vi.doMock("@/lib/sync/events-emit", () => ({ emitCellAudioAttach: emitAttach }))
    vi.doMock("./audio-attachments-bus", () => ({ notifyAudioAttachmentsChanged: vi.fn() }))

    const { generateCombinedVoice } = await import("./combined-voice")

    const makeCell = (id: string) => ({
      id,
      fileId: "f",
      type: "text",
      translated: "hi",
      original: "",
      context: "",
      cellLabel: "",
      group: "",
      status: "unvalidated" as const,
      validationStatus: "none" as const,
      activeValidators: [],
      validationHistory: [],
      history: [],
      threads: [],
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const session = { jwt: "j", username: "u" } as any

    await generateCombinedVoice({
      project: { id: "p" } as any,
      fileId: "f",
      cells: [makeCell("c1"), makeCell("c2")],
      settings: {},
      session,
      username: "u",
    })

    expect(synthCellTts).toHaveBeenCalledTimes(1)
    expect(synthForCell).not.toHaveBeenCalled()
    expect(emitAttach).toHaveBeenCalledTimes(2)
  })

  it("plain client synth uploads compressed AND the lossless WAV sibling; the attach stays compressed", async () => {
    vi.resetModules()
    const ttsBlob = new Blob(["wav-bytes"], { type: "audio/wav" })
    const upload = vi.fn(async (a: { audioId: string; ext: string }) => ({
      audioId: a.audioId, ext: a.ext,
      url: `frontier-audio://${a.audioId}.${a.ext}`, sizeBytes: 1,
    }))
    const sibling = vi.fn(async () => true)
    const emitAttach = vi.fn(async () => {})
    vi.doMock("@/lib/sync/tts", () => ({ synthesizeCellTts: vi.fn() }))
    vi.doMock("./tts", () => ({
      synthesizeForCell: vi.fn(async () => ttsBlob), setTtsStatus: vi.fn(),
      ttsStatusKey: (s: string) => s,
    }))
    vi.doMock("./voices", () => ({
      resolveCastVoice: () => ({ id: "v", name: "N", provider: "gemini" }),
    }))
    vi.doMock("./tts-providers", () => ({ resolveTtsProvider: () => "gemini" }))
    vi.doMock("./opus-encode", () => ({
      canEncodeOpus: () => true,
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
    vi.doMock("./upload", () => ({
      buildAudioId: () => "base-id", uploadCellAudio: upload,
      fetchCellAudio: vi.fn(async () => new ArrayBuffer(4)),
    }))
    vi.doMock("./sync-token-fetcher", () => ({
      audioSyncTokenFetcherForSession: () => async () => "tok",
    }))
    vi.doMock("./voice-clone", () => ({ convertToCloneVoice: vi.fn() }))
    vi.doMock("@/lib/sync/events-emit", () => ({ emitCellAudioAttach: emitAttach }))
    vi.doMock("./audio-attachments-bus", () => ({ notifyAudioAttachmentsChanged: vi.fn() }))

    const { generateCombinedVoice } = await import("./combined-voice")
    const makeCell = (id: string) => ({
      id, fileId: "f", type: "text", translated: "hi", original: "", context: "",
      cellLabel: "", group: "", status: "unvalidated" as const,
      validationStatus: "none" as const, activeValidators: [],
      validationHistory: [], history: [], threads: [],
    })
    await generateCombinedVoice({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      project: { id: "p" } as any,
      fileId: "f",
      cells: [makeCell("c1"), makeCell("c2")],
      settings: {},
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      session: { jwt: "j", username: "u" } as any,
      username: "u",
    })
    expect(upload).toHaveBeenCalledTimes(1)
    expect(upload).toHaveBeenCalledWith(expect.objectContaining({ audioId: "base-id", ext: "webm" }))
    expect(sibling).toHaveBeenCalledTimes(1)
    expect(sibling).toHaveBeenCalledWith(
      expect.objectContaining({ audioId: "base-id", wavBlob: ttsBlob }),
    )
    // Both cells attach the COMPRESSED shared clip; the sibling gets no row.
    expect(emitAttach).toHaveBeenCalledTimes(2)
    expect(emitAttach).toHaveBeenCalledWith(
      expect.objectContaining({ audioId: "base-id.webm", mimeType: "audio/webm" }),
    )
  })
})
