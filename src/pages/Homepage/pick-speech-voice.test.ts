import { describe, expect, it } from "vitest"
import { pickNaturalVoice } from "./pick-speech-voice"

function voice(partial: Partial<SpeechSynthesisVoice>): SpeechSynthesisVoice {
  return {
    name: "",
    lang: "",
    voiceURI: "",
    localService: true,
    default: false,
    ...partial,
  } as SpeechSynthesisVoice
}

describe("pickNaturalVoice", () => {
  it("returns undefined when no voices are available", () => {
    expect(pickNaturalVoice([], "es")).toBeUndefined()
    expect(pickNaturalVoice(undefined, "es")).toBeUndefined()
  })

  it("prefers a language match over a non-matching voice", () => {
    const en = voice({ name: "Alex", lang: "en-US" })
    const es = voice({ name: "Basic", lang: "es-ES" })
    expect(pickNaturalVoice([en, es], "es")).toBe(es)
  })

  it("prefers a natural/neural voice over the robotic on-device default", () => {
    const robotic = voice({ name: "eSpeak Spanish", lang: "es", voiceURI: "espeak-es" })
    const natural = voice({ name: "Google español", lang: "es-ES", localService: false })
    expect(pickNaturalVoice([robotic, natural], "es")).toBe(natural)
  })

  it("prefers a cloud (network) voice over an on-device one of the same language", () => {
    const local = voice({ name: "Mónica", lang: "es-ES", localService: true })
    const cloud = voice({ name: "Spanish (Spain)", lang: "es-ES", localService: false })
    expect(pickNaturalVoice([local, cloud], "es")).toBe(cloud)
  })

  it("demotes robotic engines even within the matching language", () => {
    const robotic = voice({ name: "español compact", lang: "es-ES" })
    const plain = voice({ name: "Jorge", lang: "es-ES" })
    expect(pickNaturalVoice([robotic, plain], "es")).toBe(plain)
  })

  it("falls back to any voice when the language is unavailable", () => {
    const en = voice({ name: "Alex", lang: "en-US" })
    expect(pickNaturalVoice([en], "es")).toBe(en)
  })

  it("keeps the first candidate when scores tie (stable)", () => {
    const a = voice({ name: "Voice A", lang: "es-ES" })
    const b = voice({ name: "Voice B", lang: "es-ES" })
    expect(pickNaturalVoice([a, b], "es")).toBe(a)
  })
})
