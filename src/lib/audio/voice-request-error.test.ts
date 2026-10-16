import { describe, expect, it } from "vitest"
import { explainVoiceRequestError } from "./voice-request-error"

const PROVIDER =
  "The voice provider couldn't create this voice. Try again later, or close this and choose a built-in voice."
const SIGN_IN =
  "Your sign-in didn't reach the voice service. Sign in again, then click Generate previews."

describe("explainVoiceRequestError (AQU-1755)", () => {
  it("turns the worker's bare 502 into the next click", () => {
    expect(explainVoiceRequestError("voice provider request failed")).toBe(PROVIDER)
    expect(
      explainVoiceRequestError("Inworld TTS failed (502): voice provider request failed"),
    ).toBe(PROVIDER)
  })

  it("turns a swallowed session rejection into a sign-in step", () => {
    expect(explainVoiceRequestError("designInworldVoice: no sync token")).toBe(SIGN_IN)
    expect(explainVoiceRequestError("publishInworldVoice: no sync token")).toBe(SIGN_IN)
    expect(explainVoiceRequestError("invalid token signature")).toBe(SIGN_IN)
  })

  it("leaves a specific provider rejection intact", () => {
    const raw = "Inworld TTS failed (400): designPrompt too long"
    expect(explainVoiceRequestError(raw)).toBe(raw)
  })
})
