import { afterEach, describe, expect, it, vi } from "vitest"
import {
  buildGeminiTtsPrompt,
  sampleRateFromMimeType,
  synthesizeGeminiTtsToWavBlob,
} from "./gemini-tts"
import { PRESET_VOICES } from "./voices"

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("Gemini TTS prompt rendering", () => {
  it("replaces cell + voice placeholders", () => {
    expect(buildGeminiTtsPrompt(
      "Bonjour",
      "Say {text} in {target}; source was {original} ({cellLabel}/{context}). Accent: {accent}.",
      { targetLanguage: "fr", original: "Hello", cellLabel: "1", context: "paragraph" },
      { accent: "Parisian" },
    )).toBe("Say Bonjour in fr; source was Hello (1/paragraph). Accent: Parisian.")
  })

  it("wraps plain guidance in protective framing so it isn't spoken", () => {
    // A template with no {text} slot is treated as free-text Guidance: it's
    // fenced as a "Voice direction" and the line to read is appended below, so
    // Gemini speaks the text and not the guidance itself.
    expect(buildGeminiTtsPrompt("Bonjour", "Read warmly.")).toBe(
      [
        "Read the following text aloud for an audio Scripture recording.",
        "Voice direction: Read warmly.",
        "Do not add any words that are not in the text. Read only the text below.",
        "",
        "Bonjour",
      ].join("\n"),
    )
  })

  it("includes the target language in the framing when provided", () => {
    expect(buildGeminiTtsPrompt("Bonjour", "Read warmly.", { targetLanguage: "fr" })).toBe(
      [
        "Read the following fr text aloud for an audio Scripture recording.",
        "Voice direction: Read warmly.",
        "Do not add any words that are not in the text. Read only the text below.",
        "",
        "Bonjour",
      ].join("\n"),
    )
  })
})

describe("Gemini TTS audio", () => {
  it("uses the returned PCM sample rate when wrapping WAV", async () => {
    const pcm = String.fromCharCode(0, 0, 255, 127)
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      candidates: [{
        content: {
          parts: [{
            inlineData: {
              data: btoa(pcm),
              mimeType: "audio/L16;codec=pcm;rate=16000",
            },
          }],
        },
      }],
    }), { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)

    const blob = await synthesizeGeminiTtsToWavBlob({
      text: "Hello",
      apiKey: "key",
      voice: PRESET_VOICES[0],
    })
    const view = new DataView(await blob.arrayBuffer())

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(view.getUint32(24, true)).toBe(16000)
    expect(view.getUint32(40, true)).toBe(4)
    expect(view.getInt16(44, true)).toBe(0)
    expect(view.getInt16(46, true)).toBe(32767)
  })

  it("defaults unknown PCM rates to 24kHz", () => {
    expect(sampleRateFromMimeType(undefined)).toBe(24000)
    expect(sampleRateFromMimeType("audio/L16")).toBe(24000)
  })
})
