import { describe, expect, it } from "vitest"
import {
  HOSTED_TTS_CREDIT_CAP_BODY,
  HOSTED_TTS_NOT_CONFIGURED_BODY,
  SEED_VC_NOT_CONFIGURED_BODY,
  errorFromHostedTts,
  errorFromVoiceConvert,
} from "./tts-engine-error"

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

  // AQU-1872: the worker refuses an out-of-credit org BEFORE calling the
  // vendor, so reporting it as a vendor failure tells the user the opposite of
  // the truth and hides the only person who can clear it.
  it("does not blame the engine when the org is out of credit", () => {
    const body = JSON.stringify({
      error: "credit_cap_exceeded",
      message: "This organization has used its daily credit allowance.",
      reason: "daily",
    })
    const message = errorFromHostedTts(429, body).message
    expect(message).toBe(HOSTED_TTS_CREDIT_CAP_BODY)
    // The three things the user needs: no audio, not the engine, who can fix it.
    expect(message).toMatch(/no audio was generated/i)
    expect(message).toMatch(/voice engine is fine/i)
    expect(message).toMatch(/org admin/i)
    // And NOT a provider red herring: the cause is already named outright, so
    // naming Gemini here would only plant the idea it is meant to rule out.
    expect(message).not.toMatch(/gemini/i)
    // And never the raw JSON the server sent.
    expect(message).not.toContain("credit_cap_exceeded")
    expect(message).not.toMatch(/^Inworld TTS failed/)
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
  it("names Seed-VC when conversion isn't wired", () => {
    expect(errorFromVoiceConvert(503, "voice conversion not configured").message).toBe(
      SEED_VC_NOT_CONFIGURED_BODY,
    )
  })

  it("still names Seed-VC on a later conversion failure", () => {
    const err = errorFromVoiceConvert(500, "gpu OOM")
    expect(err.message).toMatch(/^Voice cloning \(Seed-VC\) failed \(500\)/)
    expect(err.message).toContain("gpu OOM")
  })
})
