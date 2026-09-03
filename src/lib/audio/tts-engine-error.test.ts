import { describe, expect, it } from "vitest"
import {
  OMNIVOICE_NOT_CONFIGURED_BODY,
  SEED_VC_NOT_CONFIGURED_BODY,
  errorFromOmnivoiceTts,
  errorFromVoiceConvert,
} from "./tts-engine-error"

describe("errorFromOmnivoiceTts", () => {
  it("names OmniVoice when the local worker has no Modal endpoint", () => {
    const message = errorFromOmnivoiceTts(503, "TTS not configured").message
    expect(message).toBe(OMNIVOICE_NOT_CONFIGURED_BODY)
    expect(message).toMatch(/omnivoice/i)
    expect(message).toMatch(/not gemini/i)
  })

  it("still names OmniVoice on a later Modal failure", () => {
    const err = errorFromOmnivoiceTts(502, "upstream timeout")
    expect(err.message).toMatch(/^OmniVoice TTS failed \(502\)/)
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
