import { describe, expect, it } from "vitest"
import {
  HOSTED_TTS_NOT_CONFIGURED_BODY,
  VOICE_CONVERT_NOT_CONFIGURED_BODY,
  errorFromHostedTts,
  errorFromVoiceConvert,
} from "./tts-engine-error"
import { AiRefusalError } from "@/lib/billing/ai-refusal"

describe("errorFromHostedTts", () => {
  it("names Inworld when the local worker has no Inworld API key", () => {
    const message = errorFromHostedTts(503, "TTS not configured").message
    expect(message).toBe(HOSTED_TTS_NOT_CONFIGURED_BODY)
    expect(message).toMatch(/inworld/i)
    expect(message).toMatch(/not gemini/i)
  })

  it("still names Inworld on a later upstream failure", () => {
    const err = errorFromHostedTts(502, "upstream timeout")
    expect(err.message).toMatch(/^Inworld TTS failed \(502\)/)
    expect(err.message).toContain("upstream timeout")
  })

  // AQU-1872/AQU-2068: the worker refuses an out-of-allowance org BEFORE
  // calling the vendor, so reporting it as a vendor failure tells the user the
  // opposite of the truth. The one refusal helper words it, and meters flip.
  it("does not blame the engine when the workspace is out of allowance", () => {
    const body = JSON.stringify({
      error: "credit_cap_exceeded",
      message: "This organization has used its daily credit allowance.",
      reason: "daily",
    })
    const err = errorFromHostedTts(429, body)
    expect(err).toBeInstanceOf(AiRefusalError)
    expect(err.message).toMatch(/used this week's AI/i)
    // Not a provider red herring, not the raw JSON, and never an amount.
    expect(err.message).not.toMatch(/gemini|credit/i)
    expect(err.message).not.toMatch(/^Inworld TTS failed/)
  })

  it("reads the 402 contract the same way", () => {
    const err = errorFromHostedTts(402, JSON.stringify({ error: "ai_allowance_exhausted", tier: "free" }))
    expect(err).toBeInstanceOf(AiRefusalError)
  })

  it("leaves other 429s on the generic path", () => {
    // WHY: the per-user seconds cap and the flood throttle are different
    // refusals with their own wording; this branch must not swallow them.
    expect(errorFromHostedTts(429, '{"error":"rate_limited"}').message).toMatch(
      /^Inworld TTS failed \(429\)/,
    )
    expect(
      errorFromHostedTts(429, '{"error":"tts_daily_limit_exceeded"}').message,
    ).toMatch(/^Inworld TTS failed \(429\)/)
  })
})

describe("errorFromVoiceConvert", () => {
  it("says voice conversion isn't set up when the worker has no voice forge", () => {
    expect(errorFromVoiceConvert(503, "voice conversion not configured").message).toBe(
      VOICE_CONVERT_NOT_CONFIGURED_BODY,
    )
  })

  it("reports a later conversion failure without naming one engine (AQU-2212)", () => {
    const err = errorFromVoiceConvert(500, "gpu OOM")
    expect(err.message).toMatch(/^Voice conversion failed \(500\)/)
    expect(err.message).toContain("gpu OOM")
  })

  it("turns a worker timeout into a retry hint", () => {
    expect(errorFromVoiceConvert(504, "did not respond within 240s").message).toMatch(/starting up/)
  })
})
