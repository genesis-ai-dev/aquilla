// AQU-2742: Make speech must not offer a voice that cannot speak the lane.
// WHY: picking one spent a run and ended in an engine error the panel could
// have predicted (no key, still training, made for another language).
import { describe, expect, it } from "vitest"
import type { Voice } from "@/lib/parsers/types"
import { voiceBlocker, type VoiceUsableContext } from "./voice-usable"

const ctx = (over: Partial<VoiceUsableContext> = {}): VoiceUsableContext => ({
  hasElevenLabsKey: true, hasGeminiKey: true, laneLanguage: "es", ...over,
})
const el: Voice = { id: "el", name: "Layla", provider: "elevenlabs", elevenLabs: { voiceId: "x" } }
const gem: Voice = { id: "g", name: "Kore", provider: "gemini", voiceName: "Kore" }
const nova: Voice = { id: "n", name: "Nova", provider: "inworld", language: "en-US" }
const custom: Voice = {
  id: "c", name: "Hearth", libraryVoiceId: "c-1",
  customVoice: { speakerName: "H", consentAttestedAt: "", consentAttestedBy: "", consentStatementVersion: "", trainingStartedAt: "" },
}

describe("voiceBlocker", () => {
  it("blocks an ElevenLabs voice only without a key", () => {
    expect(voiceBlocker(el, ctx({ hasElevenLabsKey: false }))).toEqual({ kind: "elevenlabs-key" })
    expect(voiceBlocker(el, ctx())).toBeNull()
  })

  it("blocks a Gemini voice only without a key, including through the project engine", () => {
    expect(voiceBlocker(gem, ctx({ hasGeminiKey: false }))).toEqual({ kind: "gemini-key" })
    const plain: Voice = { id: "p", name: "P" }
    expect(voiceBlocker(plain, ctx({ hasGeminiKey: false, projectProvider: "gemini" }))).toEqual({ kind: "gemini-key" })
    expect(voiceBlocker(plain, ctx({ hasGeminiKey: false }))).toBeNull()
  })

  it("blocks an Inworld voice made for another language, not one for this language or an unmappable lane", () => {
    expect(voiceBlocker(nova, ctx())).toEqual({ kind: "language", language: "en-US" })
    expect(voiceBlocker(nova, ctx({ laneLanguage: "en-GB" }))).toBeNull()
    expect(voiceBlocker(nova, ctx({ laneLanguage: "Ancient Greek (Koine)" }))).toBeNull()
    expect(voiceBlocker({ ...nova, language: undefined }, ctx())).toBeNull()
  })

  it("blocks a custom voice while it trains or after training failed, not while unknown", () => {
    expect(voiceBlocker(custom, ctx({ customState: () => "training" }))).toEqual({ kind: "training" })
    expect(voiceBlocker(custom, ctx({ customState: () => "queued" }))).toEqual({ kind: "training" })
    expect(voiceBlocker(custom, ctx({ customState: () => "failed" }))).toEqual({ kind: "training-failed" })
    expect(voiceBlocker(custom, ctx({ customState: () => "ready" }))).toBeNull()
    expect(voiceBlocker(custom, ctx({ customState: () => null }))).toBeNull()
  })
})
