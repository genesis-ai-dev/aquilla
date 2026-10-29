// AQU-2299: the client half of the ElevenLabs BYOK contract. The user's key
// goes to our sync-worker in X-ElevenLabs-Key (never a URL), a missing key
// fails before anything is sent, and cloning uploads the samples to the
// project's reference store before asking for the clone with the consent
// version the worker checks.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const uploadVoiceReference = vi.fn(async () => {})
vi.mock("@/lib/audio/voice-clone", () => ({
  buildVoiceReferenceId: (ext: string) => `ref-1.${ext}`,
  uploadVoiceReference: (...a: unknown[]) => uploadVoiceReference(...(a as [])),
}))

const { setElevenLabsKey } = await import("@/lib/audio/elevenlabs/key")
const {
  ELEVENLABS_KEY_HEADER,
  ELEVENLABS_PROJECT_SCOPE_FILE_ID,
  cloneElevenLabsVoice,
  fetchElevenLabsAccount,
  synthesizeElevenLabsTts,
} = await import("./elevenlabs")
const { CUSTOM_VOICE_CONSENT_VERSION } = await import("@/lib/audio/custom-voice")

const KEY = "sk_test_device_key"
const fetchMock = vi.fn()
const getSyncToken = vi.fn(async () => "sync-tok")

beforeEach(() => {
  fetchMock.mockReset()
  getSyncToken.mockClear()
  uploadVoiceReference.mockClear()
  vi.stubGlobal("fetch", fetchMock)
  setElevenLabsKey(KEY)
})
afterEach(() => {
  vi.unstubAllGlobals()
  setElevenLabsKey(undefined)
})

describe("ElevenLabs client", () => {
  it("sends the device key in its header and the sync token as auth, never in the URL", async () => {
    fetchMock.mockResolvedValue(Response.json({ audioId: "a", durationSeconds: 1, objectName: "a.mp3", url: "frontier-audio://a.mp3" }))
    await synthesizeElevenLabsTts({ projectId: "p1", fileId: "f1", text: "Hi", voiceId: "v1" }, getSyncToken)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const headers = init.headers as Record<string, string>
    expect(url).toMatch(/\/api\/v1\/elevenlabs\/tts$/)
    expect(url).not.toContain(KEY)
    expect(headers[ELEVENLABS_KEY_HEADER]).toBe(KEY)
    expect(headers.Authorization).toBe("Bearer sync-tok")
    expect(getSyncToken).toHaveBeenCalledWith("p1", "f1")
  })

  it("fails with the no-key error before minting a token or calling the worker", async () => {
    setElevenLabsKey(undefined)
    await expect(fetchElevenLabsAccount({ projectId: "p1" }, getSyncToken)).rejects.toThrow(/^ElevenLabs \(no key\)/)
    expect(getSyncToken).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("validates an explicit key (the Connect card) with a project-scope token", async () => {
    fetchMock.mockResolvedValue(Response.json({ tier: "creator", characterCount: 1, characterLimit: 10, canClone: true, resetAtUnix: null }))
    await fetchElevenLabsAccount({ projectId: "p1", apiKey: "sk_pasted" }, getSyncToken)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect((init.headers as Record<string, string>)[ELEVENLABS_KEY_HEADER]).toBe("sk_pasted")
    expect(getSyncToken).toHaveBeenCalledWith("p1", ELEVENLABS_PROJECT_SCOPE_FILE_ID)
  })

  it("maps a worker error body onto the ElevenLabs failure", async () => {
    fetchMock.mockResolvedValue(Response.json({ error: "elevenlabs_quota_exceeded", message: "out" }, { status: 402 }))
    await expect(synthesizeElevenLabsTts({ projectId: "p1", fileId: "f1", text: "Hi", voiceId: "v1" }, getSyncToken))
      .rejects.toThrow(/^ElevenLabs \(out of characters\)/)
  })

  it("uploads samples to the reference store, then clones with the consent version", async () => {
    fetchMock.mockResolvedValue(Response.json({ voiceId: "new", requiresVerification: false, attestedAt: "t", statementVersion: CUSTOM_VOICE_CONSENT_VERSION }))
    const onProgress = vi.fn()
    await expect(cloneElevenLabsVoice({
      projectId: "p1", name: "Maria", recordings: [new File([new Uint8Array(1)], "a.wav")],
      removeBackgroundNoise: true, consentConfirmed: false,
    }, getSyncToken)).rejects.toThrow(/consent/)
    expect(uploadVoiceReference).not.toHaveBeenCalled()

    await cloneElevenLabsVoice({
      projectId: "p1", name: "Maria", recordings: [new File([new Uint8Array(1)], "a.wav")],
      removeBackgroundNoise: true, consentConfirmed: true, onProgress,
    }, getSyncToken)
    expect(uploadVoiceReference).toHaveBeenCalledWith(expect.objectContaining({ projectId: "p1", referenceAudioId: "ref-1.wav" }))
    expect(onProgress).toHaveBeenCalledWith(1, 1)
    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body)) as Record<string, unknown>
    expect(body).toEqual({
      projectId: "p1", name: "Maria", referenceAudioIds: ["ref-1.wav"], removeBackgroundNoise: true,
      consent: { confirmed: true, statementVersion: CUSTOM_VOICE_CONSENT_VERSION },
    })
  })
})
