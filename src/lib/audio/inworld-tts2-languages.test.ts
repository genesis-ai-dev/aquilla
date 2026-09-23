import { describe, expect, it } from "vitest"
import { INWORLD_TTS2_LANGUAGE_CODES, INWORLD_TTS2_LANGUAGE_NAMES } from "./inworld-tts2-languages"

describe("INWORLD_TTS2_LANGUAGE_CODES", () => {
  it("is the published TTS-2 language table without duplicates", () => {
    expect(INWORLD_TTS2_LANGUAGE_CODES.length).toBeGreaterThanOrEqual(90)
    expect(new Set(INWORLD_TTS2_LANGUAGE_CODES).size).toBe(INWORLD_TTS2_LANGUAGE_CODES.length)
    expect(INWORLD_TTS2_LANGUAGE_CODES).toEqual(expect.arrayContaining([
      "en", "es", "sw", "fil", "yue", "ta", "ar", "he",
    ]))
  })

  it("names dialect subtags that Intl.DisplayNames leaves as codes", () => {
    expect(INWORLD_TTS2_LANGUAGE_NAMES.arz).toBe("Egyptian Arabic")
    expect(INWORLD_TTS2_LANGUAGE_NAMES.uzn).toBe("Northern Uzbek")
  })
})
