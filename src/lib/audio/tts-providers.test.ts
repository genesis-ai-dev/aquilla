import { describe, expect, it } from "vitest"
import { audio } from "@/lib/i18n/namespaces/audio"
import {
  DEFAULT_GEMINI_VOICE,
  DEFAULT_INWORLD_VOICE,
  DEFAULT_MMS_LANGUAGE,
  DEFAULT_TTS_PROVIDER,
  TTS_PROVIDER_INFOS,
  defaultVoiceNameForProvider,
  effectiveTtsProvider,
  inferMmsLanguageCode,
  isInworldVoiceName,
  isLegacyKokoroVoiceName,
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

  it("remaps leftover Kokoro onto Inworld and drops speaker ids", () => {
    expect(effectiveTtsProvider("kokoro")).toBe("inworld")
    expect(isServerTtsProvider("kokoro")).toBe(true)
    expect(providerInfo("kokoro").id).toBe("inworld")
    expect(defaultVoiceNameForProvider("kokoro")).toBe(DEFAULT_INWORLD_VOICE)
    expect(normalizeVoiceForProvider(geminiVoice, "kokoro").provider).toBe("inworld")
    expect(normalizeVoiceForProvider(geminiVoice, "kokoro").voiceName).toBe(DEFAULT_INWORLD_VOICE)
    const leftover: Voice = { ...geminiVoice, voiceName: "af_bella" }
    expect(normalizeVoiceForProvider(leftover, "inworld").voiceName).toBe(DEFAULT_INWORLD_VOICE)
    expect(isLegacyKokoroVoiceName("af_bella")).toBe(true)
    expect(isLegacyKokoroVoiceName("bf_emma")).toBe(true)
    expect(isInworldVoiceName("af_bella")).toBe(false)
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
    const leftover: Voice = { ...geminiVoice, voiceName: "af_bella" }
    expect(normalizeVoiceForProvider(leftover, "gemini").voiceName).toBe(DEFAULT_GEMINI_VOICE)
  })

  it("keeps an ElevenLabs voice's account voice and drops it when switching engines (AQU-2299)", () => {
    const el: Voice = {
      id: "v", name: "Rachel", provider: "elevenlabs", voiceName: "Dennis", language: "es", audioQuality: "highest",
      elevenLabs: { voiceId: "el123" },
    }
    const kept = normalizeVoiceForProvider(el, "elevenlabs")
    expect(kept).toMatchObject({ provider: "elevenlabs", language: "es", elevenLabs: { voiceId: "el123", modelId: "eleven_multilingual_v2" } })
    expect(kept.voiceName).toBeUndefined()
    expect(kept.audioQuality).toBeUndefined()
    expect(isServerTtsProvider("elevenlabs")).toBe(true)
    expect(normalizeVoiceForProvider(el, "inworld").elevenLabs).toBeUndefined()
  })

  it("defaults to inworld", () => {
    expect(DEFAULT_TTS_PROVIDER).toBe("inworld")
  })

  it("lists the engines with cloud engines first", () => {
    expect(TTS_PROVIDER_INFOS.map((p) => p.id)).toEqual([
      "inworld", "gemini", "elevenlabs", "mms",
    ])
  })

  it("describes Inworld as both TTS 2 and Flash", () => {
    const inworld = TTS_PROVIDER_INFOS.find((p) => p.id === "inworld")
    expect(inworld?.blurb).toMatch(/TTS 2/)
    expect(inworld?.blurb).toMatch(/Flash/)
    const hint = audio.keys["audio.provider.inworldHint"]
    expect(hint).toMatch(/TTS 2 Flash/)
    expect(hint).toMatch(/Highest uses Inworld TTS 2/)
  })

  it("gives every engine named voices, including Inworld", () => {
    const byId = Object.fromEntries(TTS_PROVIDER_INFOS.map((p) => [p.id, p]))
    expect(byId.inworld.hasNamedVoices).toBe(true)
    expect(byId.gemini.hasNamedVoices).toBe(true)
    expect(byId.mms.hasNamedVoices).toBe(true)
  })

  it("tags each engine with its run tier", () => {
    const byId = Object.fromEntries(TTS_PROVIDER_INFOS.map((p) => [p.id, p]))
    expect(byId.inworld.tier).toBe("cloud")
    expect(byId.gemini.tier).toBe("cloud")
    expect(byId.mms.tier).toBe("device")
  })

  it("gives inworld the Dennis stock voice by default", () => {
    expect(defaultVoiceNameForProvider("inworld")).toBe(DEFAULT_INWORLD_VOICE)
  })

  it("normalizes Gemini names onto Dennis when switching to inworld", () => {
    expect(normalizeVoiceForProvider(geminiVoice, "inworld").voiceName).toBe(DEFAULT_INWORLD_VOICE)
    expect(normalizeVoiceForProvider(geminiVoice, "inworld").provider).toBe("inworld")
    expect(normalizeVoiceForProvider(geminiVoice, "inworld").audioQuality).toBe("highest")
    expect(normalizeVoiceForProvider(geminiVoice, "inworld").deliveryMode).toBe("STABLE")
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

  it("keeps an Inworld Voice Design id", () => {
    const designed: Voice = { ...geminiVoice, voiceName: "ws__design-voice-38b05df9" }
    expect(isInworldVoiceName(designed.voiceName)).toBe(true)
    expect(normalizeVoiceForProvider(designed, "inworld").voiceName).toBe("ws__design-voice-38b05df9")
  })

  it("accepts live catalog ids such as Alex without treating Gemini names as Inworld", () => {
    expect(isInworldVoiceName("Alex")).toBe(true)
    expect(isInworldVoiceName("Kore")).toBe(false)
    expect(isInworldVoiceName("af_bella")).toBe(false)
    expect(normalizeVoiceForProvider({ ...geminiVoice, voiceName: "Alex" }, "inworld").voiceName).toBe("Alex")
  })

  // AQU-2152 — the catalog ids are Inworld's own display names, so the accented
  // ones (fr Étienne/Hélène, pt Maitê) are as valid as Alain. An ASCII-only
  // shape check rejected them and every normalize put Dennis back, so the Edit
  // voice picker and the generate path both spoke as Dennis.
  it("accepts accented catalog ids", () => {
    expect(isInworldVoiceName("Étienne")).toBe(true)
    expect(isInworldVoiceName("Hélène")).toBe(true)
    expect(isInworldVoiceName("Maitê")).toBe(true)
    expect(isInworldVoiceName("Alain")).toBe(true)
    // Same name NFD-decomposed (E + combining acute) — one byte sequence apart.
    expect(isInworldVoiceName("E\u0301tienne")).toBe(true)
  })

  it("keeps an accented catalog id through normalization", () => {
    for (const voiceName of ["Étienne", "Hélène", "Alain"]) {
      expect(normalizeVoiceForProvider({ ...geminiVoice, voiceName }, "inworld").voiceName).toBe(voiceName)
    }
  })

  it("still narrows to Dennis for an empty, Gemini or leftover Kokoro speaker", () => {
    expect(normalizeVoiceForProvider({ ...geminiVoice, voiceName: "" }, "inworld").voiceName)
      .toBe(DEFAULT_INWORLD_VOICE)
    expect(normalizeVoiceForProvider({ ...geminiVoice, voiceName: "Kore" }, "inworld").voiceName)
      .toBe(DEFAULT_INWORLD_VOICE)
    expect(normalizeVoiceForProvider({ ...geminiVoice, voiceName: "af_bella" }, "inworld").voiceName)
      .toBe(DEFAULT_INWORLD_VOICE)
    expect(isInworldVoiceName("eng")).toBe(false)
    expect(isInworldVoiceName("fra")).toBe(false)
  })
})
