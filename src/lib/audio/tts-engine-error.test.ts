import { describe, expect, it } from "vitest"
import {
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
