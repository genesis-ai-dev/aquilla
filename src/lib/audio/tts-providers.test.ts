import { describe, expect, it } from "vitest"
import {
  DEFAULT_GEMINI_VOICE,
  DEFAULT_KOKORO_VOICE,
  DEFAULT_MMS_LANGUAGE,
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

  it("does not infer unsupported MMS repos", () => {
    expect(inferMmsLanguageCode("it")).toBeUndefined()
    expect(inferMmsLanguageCode("ita")).toBeUndefined()
    expect(inferMmsLanguageCode("sw-KE")).toBeUndefined()
  })

  it("falls back to target language for MMS when the voice is incompatible", () => {
    expect(normalizeVoiceForProvider(geminiVoice, "mms", { targetLanguage: "es-MX" }).voiceName).toBe("spa")
  })

  it("does not pass local voice ids to Gemini", () => {
    const kokoro: Voice = { ...geminiVoice, voiceName: "af_bella" }
    expect(normalizeVoiceForProvider(kokoro, "gemini").voiceName).toBe(DEFAULT_GEMINI_VOICE)
  })
})
