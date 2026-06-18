import { describe, expect, it } from "vitest"
import {
  DEFAULT_GEMINI_VOICE,
  DEFAULT_KOKORO_VOICE,
  DEFAULT_MMS_LANGUAGE,
  DEFAULT_TTS_PROVIDER,
  TTS_PROVIDER_INFOS,
  defaultVoiceNameForProvider,
  inferMmsLanguageCode,
  normalizeVoiceForProvider,
} from "./tts-providers"
import type { Voice } from "@/lib/parsers/types"

const geminiVoice: Voice = {
  id: "v1",
  name: "Narrator",
  provider: "gemini",
  voiceName: "Charon",
}

describe("TTS provider normalization", () => {
  it("keeps valid Gemini voices", () => {
    expect(normalizeVoiceForProvider(geminiVoice, "gemini").voiceName).toBe("Charon")
  })

  it("does not pass Gemini voice ids to Kokoro", () => {
    expect(normalizeVoiceForProvider(geminiVoice, "kokoro").voiceName).toBe(DEFAULT_KOKORO_VOICE)
  })

  it("does not pass Gemini voice ids to MMS", () => {
    expect(normalizeVoiceForProvider(geminiVoice, "mms").voiceName).toBe(DEFAULT_MMS_LANGUAGE)
  })

  it("infers MMS codes from common language tags", () => {
    expect(inferMmsLanguageCode("es-MX")).toBe("spa")
    expect(inferMmsLanguageCode("fr")).toBe("fra")
    expect(inferMmsLanguageCode("eng")).toBe("eng")
  })

  it("accepts extended MMS repository codes", () => {
    expect(inferMmsLanguageCode("ita")).toBe("ita")
  })

  it("does not infer short language tags without an MMS mapping", () => {
    expect(inferMmsLanguageCode("it")).toBeUndefined()
    expect(inferMmsLanguageCode("sw-KE")).toBeUndefined()
  })

  it("falls back to target language for MMS when the voice is incompatible", () => {
    expect(normalizeVoiceForProvider(geminiVoice, "mms", { targetLanguage: "es-MX" }).voiceName).toBe("spa")
  })

  it("does not pass local voice ids to Gemini", () => {
    const kokoro: Voice = { ...geminiVoice, voiceName: "af_bella" }
    expect(normalizeVoiceForProvider(kokoro, "gemini").voiceName).toBe(DEFAULT_GEMINI_VOICE)
  })

  it("defaults to omnivoice", () => {
    expect(DEFAULT_TTS_PROVIDER).toBe("omnivoice")
  })

  it("lists all four engines with cloud engines first", () => {
    expect(TTS_PROVIDER_INFOS.map((p) => p.id)).toEqual([
      "omnivoice", "gemini", "kokoro", "mms",
    ])
  })

  it("marks only cloud engines as cloning-capable", () => {
    const byId = Object.fromEntries(TTS_PROVIDER_INFOS.map((p) => [p.id, p]))
    expect(byId.omnivoice.supportsCloning).toBe(true)
    expect(byId.gemini.supportsCloning).toBe(true)
    expect(byId.kokoro.supportsCloning).toBe(false)
    expect(byId.mms.supportsCloning).toBe(false)
  })

  it("marks omnivoice as the only engine without named voices", () => {
    const byId = Object.fromEntries(TTS_PROVIDER_INFOS.map((p) => [p.id, p]))
    expect(byId.omnivoice.hasNamedVoices).toBe(false)
    expect(byId.gemini.hasNamedVoices).toBe(true)
    expect(byId.kokoro.hasNamedVoices).toBe(true)
    expect(byId.mms.hasNamedVoices).toBe(true)
  })

  it("tags each engine with its run tier", () => {
    const byId = Object.fromEntries(TTS_PROVIDER_INFOS.map((p) => [p.id, p]))
    expect(byId.omnivoice.tier).toBe("cloud")
    expect(byId.gemini.tier).toBe("cloud")
    expect(byId.kokoro.tier).toBe("device")
    expect(byId.mms.tier).toBe("device")
  })

  it("gives omnivoice no base voice name", () => {
    expect(defaultVoiceNameForProvider("omnivoice")).toBe("")
  })

  it("clears the voice name when normalizing to omnivoice", () => {
    expect(normalizeVoiceForProvider(geminiVoice, "omnivoice").voiceName).toBe("")
  })
})
