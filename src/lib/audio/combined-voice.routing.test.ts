import { describe, expect, it, vi } from "vitest"

describe("generateCombinedVoice routing", () => {
  it("inworld voice uses server TTS path and attaches to all cells", async () => {
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
      resolveCastVoice: () => ({ id: "v", name: "N", provider: "inworld", voiceName: "Dennis" }),
    }))
    vi.doMock("./upload", () => ({
      buildAudioId: () => "id",
      uploadCellAudio: vi.fn(),
      fetchCellAudio: vi.fn(async () => new ArrayBuffer(4)),
    }))
    vi.doMock("./sync-token-fetcher", () => ({
      audioSyncTokenFetcherForSession: () => async () => "tok",
    }))
    vi.doMock("./voice-clone", () => ({ convertToLibraryVoice: vi.fn() }))
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
    // AQU-1572: one shared clip, one `audio generated` per line it landed on.
    const attaches = (emitAttach.mock.calls as unknown as Array<[Record<string, unknown>]>).map(([a]) => a)
    expect(attaches.map((a) => [a.cellId, a.audioOrigin, a.surface])).toEqual([
      ["c1", "generate", "voice-together"],
      ["c2", "generate", "voice-together"],
    ])
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
    vi.doMock("./tts-providers", () => ({
      resolveTtsProvider: () => "gemini",
      isServerTtsProvider: () => false,
    }))
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
    vi.doMock("./voice-clone", () => ({ convertToLibraryVoice: vi.fn() }))
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

  // AQU-1978: the clip is asked for in the languages of the LANES it performs.
  // It read the retired project-level pair, empty on every new project.
  const laneProject = {
    id: "p",
    sourceLanguage: "",
    targetLanguage: "",
    lanes: [
      { id: "src00001", role: "source", language: "English", name: null, langCode: null, legacyTag: null, position: 0, archivedAt: null },
      { id: "spa00001", role: "target", language: "Spanish", name: null, langCode: null, legacyTag: "Spanish", position: 0, archivedAt: null },
      // An un-backfilled lane whose tag is its language code.
      { id: "frc00001", role: "target", language: null, name: null, langCode: null, legacyTag: "fr", position: 1, archivedAt: null },
    ],
  }
  const laneCell = (id: string) => ({
    id, fileId: "f", type: "text", translated: "hola", original: "", context: "",
    cellLabel: "", group: "", status: "unvalidated" as const,
    validationStatus: "none" as const, activeValidators: [],
    validationHistory: [], history: [], threads: [],
  })
  function mockCommon(emitAttach = vi.fn(async () => {})) {
    vi.doMock("./upload", () => ({
      buildAudioId: () => "base-id",
      uploadCellAudio: vi.fn(async () => ({ audioId: "base-id", ext: "wav", url: "frontier-audio://base-id.wav" })),
      fetchCellAudio: vi.fn(async () => new ArrayBuffer(4)),
    }))
    vi.doMock("./opus-encode", () => ({ canEncodeOpus: () => false, encodeMonoToWebmOpus: vi.fn() }))
    vi.doMock("./bytes-cache", () => ({ audioCachePutBlob: vi.fn(async () => {}) }))
    vi.doMock("./sync-token-fetcher", () => ({
      audioSyncTokenFetcherForSession: () => async () => "tok",
    }))
    vi.doMock("./voice-clone", () => ({ convertToLibraryVoice: vi.fn() }))
    vi.doMock("@/lib/sync/events-emit", () => ({ emitCellAudioAttach: emitAttach }))
    vi.doMock("./audio-attachments-bus", () => ({ notifyAudioAttachmentsChanged: vi.fn() }))
  }

  it("a client-synth clip is told the lanes' languages (AQU-1978)", async () => {
    vi.resetModules()
    const synthForCell = vi.fn(async (..._a: unknown[]) => new Blob(["x"], { type: "audio/wav" }))
    vi.doMock("@/lib/sync/tts", () => ({ synthesizeCellTts: vi.fn() }))
    vi.doMock("./tts", () => ({
      synthesizeForCell: synthForCell, setTtsStatus: vi.fn(), ttsStatusKey: (s: string) => s,
    }))
    vi.doMock("./voices", () => ({
      resolveCastVoice: () => ({ id: "v", name: "N", provider: "gemini" }),
    }))
    vi.doMock("./tts-providers", () => ({
      resolveTtsProvider: () => "gemini",
      isServerTtsProvider: () => false,
    }))
    mockCommon()
    const { generateCombinedVoice } = await import("./combined-voice")
    await generateCombinedVoice({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      project: laneProject as any,
      fileId: "f",
      cells: [laneCell("c1"), laneCell("c2")],
      settings: {},
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      session: { jwt: "j", username: "u" } as any,
      username: "u",
      targetLang: "Spanish",
    })
    const opts = synthForCell.mock.calls[0][1] as { geminiContext: Record<string, unknown> }
    expect(opts.geminiContext).toMatchObject({ sourceLanguage: "English", targetLanguage: "Spanish" })
  })

  it("an Inworld clip is asked for in the open lane's language (AQU-1978)", async () => {
    vi.resetModules()
    const synthCellTts = vi.fn(async (..._a: unknown[]) => ({
      audioId: "a", durationSeconds: 1, objectName: "a.wav", url: "frontier-audio://a.wav",
    }))
    vi.doMock("@/lib/sync/tts", () => ({ synthesizeCellTts: synthCellTts }))
    vi.doMock("./tts", () => ({
      synthesizeForCell: vi.fn(), setTtsStatus: vi.fn(), ttsStatusKey: (s: string) => s,
    }))
    vi.doMock("./voices", () => ({
      resolveCastVoice: () => ({ id: "v", name: "N", provider: "inworld", voiceName: "Dennis" }),
    }))
    vi.doUnmock("./tts-providers")
    mockCommon()
    const { generateCombinedVoice } = await import("./combined-voice")
    await generateCombinedVoice({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      project: laneProject as any,
      fileId: "f",
      cells: [laneCell("c1"), laneCell("c2")],
      settings: {},
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      session: { jwt: "j", username: "u" } as any,
      username: "u",
      targetLang: "fr",
    })
    expect(synthCellTts.mock.calls[0][0]).toMatchObject({ language: "fr" })
  })
})
