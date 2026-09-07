import { describe, expect, it } from "vitest"
import {
  DEFAULT_GEMINI_VOICE,
  DEFAULT_INWORLD_VOICE,
  DEFAULT_KOKORO_VOICE,
  DEFAULT_MMS_LANGUAGE,
  DEFAULT_TTS_PROVIDER,
  TTS_PROVIDER_INFOS,
  defaultVoiceNameForProvider,
  effectiveTtsProvider,
  inferMmsLanguageCode,
  isServerTtsProvider,
  normalizeVoiceForProvider,
  providerInfo,
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

  it("does not treat a BCP-47 tag as a Kokoro voice id", () => {
    const tagged: Voice = { ...geminiVoice, voiceName: "en-us" }
    expect(normalizeVoiceForProvider(tagged, "kokoro").voiceName).toBe(DEFAULT_KOKORO_VOICE)
  })

  it("picks a British Kokoro voice when the target language is en-gb", () => {
    expect(defaultVoiceNameForProvider("kokoro", { targetLanguage: "en-gb" })).toBe("bf_emma")
    expect(
      normalizeVoiceForProvider(geminiVoice, "kokoro", { targetLanguage: "en-GB" }).voiceName,
    ).toBe("bf_emma")
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

  it("defaults to inworld", () => {
    expect(DEFAULT_TTS_PROVIDER).toBe("inworld")
  })

  it("lists all four engines with cloud engines first", () => {
    expect(TTS_PROVIDER_INFOS.map((p) => p.id)).toEqual([
      "inworld", "gemini", "kokoro", "mms",
    ])
  })

  it("marks only cloud engines as cloning-capable", () => {
    const byId = Object.fromEntries(TTS_PROVIDER_INFOS.map((p) => [p.id, p]))
    expect(byId.inworld.supportsCloning).toBe(true)
    expect(byId.gemini.supportsCloning).toBe(true)
    expect(byId.kokoro.supportsCloning).toBe(false)
    expect(byId.mms.supportsCloning).toBe(false)
  })

  it("gives every engine named voices, including Inworld", () => {
    const byId = Object.fromEntries(TTS_PROVIDER_INFOS.map((p) => [p.id, p]))
    expect(byId.inworld.hasNamedVoices).toBe(true)
    expect(byId.gemini.hasNamedVoices).toBe(true)
    expect(byId.kokoro.hasNamedVoices).toBe(true)
    expect(byId.mms.hasNamedVoices).toBe(true)
  })

  it("tags each engine with its run tier", () => {
    const byId = Object.fromEntries(TTS_PROVIDER_INFOS.map((p) => [p.id, p]))
    expect(byId.inworld.tier).toBe("cloud")
    expect(byId.gemini.tier).toBe("cloud")
    expect(byId.kokoro.tier).toBe("device")
    expect(byId.mms.tier).toBe("device")
  })

  it("gives inworld the Dennis stock voice by default", () => {
    expect(defaultVoiceNameForProvider("inworld")).toBe(DEFAULT_INWORLD_VOICE)
  })

  it("normalizes Gemini names onto Dennis when switching to inworld", () => {
    expect(normalizeVoiceForProvider(geminiVoice, "inworld").voiceName).toBe(DEFAULT_INWORLD_VOICE)
    expect(normalizeVoiceForProvider(geminiVoice, "inworld").provider).toBe("inworld")
  })

  it("remaps persisted omnivoice ids to inworld at runtime", () => {
    expect(effectiveTtsProvider("omnivoice")).toBe("inworld")
    expect(effectiveTtsProvider(undefined)).toBe("inworld")
    expect(isServerTtsProvider("omnivoice")).toBe(true)
    expect(isServerTtsProvider("inworld")).toBe(true)
    expect(isServerTtsProvider("gemini")).toBe(false)
    expect(providerInfo("omnivoice").id).toBe("inworld")
    expect(normalizeVoiceForProvider(geminiVoice, "omnivoice").provider).toBe("inworld")
    expect(defaultVoiceNameForProvider("omnivoice")).toBe(DEFAULT_INWORLD_VOICE)
  })

  it("keeps an Inworld Instant Voice Cloning id", () => {
    const cloned: Voice = { ...geminiVoice, voiceName: "ws__narrator_20260907_120000z" }
    expect(normalizeVoiceForProvider(cloned, "inworld").voiceName).toBe("ws__narrator_20260907_120000z")
  })
})
