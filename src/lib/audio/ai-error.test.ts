// AQU-788 regression guard: an OmniVoice clone/TTS failure must be legible.
// Before the fix, a 503 "TTS not configured" (or a 502 upstream failure) fell
// through categorizeAiError to the generic "unknown"/"Couldn't generate" bucket
// with raw exception text, and an empty clip could even report success — so a
// clone that couldn't run looked like it silently did nothing. These assert the
// failure is categorized as a named, actionable OmniVoice-unavailable error
// without stealing errors that belong to other engines.

import { describe, it, expect } from "vitest"
import { categorizeAiError } from "./ai-error"

describe("categorizeAiError — OmniVoice unavailable (AQU-788)", () => {
  it("categorizes the 503 'not configured' voice/tts error as tts-provider-unavailable", () => {
    // The exact message synthesizeCellTts throws when the worker returns 503.
    const err = categorizeAiError("OmniVoice voice/tts failed (503): TTS not configured")
    expect(err.category).toBe("tts-provider-unavailable")
    expect(err.title).toMatch(/omnivoice/i)
    // Body must guide the user, not just echo the raw text.
    expect(err.body.toLowerCase()).toContain("engine")
  })

  it("categorizes an upstream 502 voice/tts failure as tts-provider-unavailable", () => {
    const err = categorizeAiError("OmniVoice voice/tts failed (502): TTS upstream unreachable: TypeError")
    expect(err.category).toBe("tts-provider-unavailable")
  })

  it("categorizes the empty-audio guard failure as tts-provider-unavailable", () => {
    const err = categorizeAiError("OmniVoice voice/tts failed (502): TTS failed: OmniVoice returned no audio")
    expect(err.category).toBe("tts-provider-unavailable")
  })

  it("still routes a genuine Gemini API-key error to missing-gemini-key", () => {
    // Regression: the OmniVoice check sits before the key check, so it must not
    // swallow other engines' key errors.
    const err = categorizeAiError("Gemini API key required for this voice")
    expect(err.category).toBe("missing-gemini-key")
  })

  it("still routes the daily quota error to daily-quota-exceeded", () => {
    const err = categorizeAiError("Daily AI limit reached — resets at midnight UTC")
    expect(err.category).toBe("daily-quota-exceeded")
  })

  it("does not reclassify a Seed-VC convert failure (non-OmniVoice clone path)", () => {
    // convertToCloneVoice throws "voice convert failed (...)", NOT "voice/tts".
    const err = categorizeAiError("voice convert failed (500): seed-vc boom")
    expect(err.category).not.toBe("tts-provider-unavailable")
  })
})
