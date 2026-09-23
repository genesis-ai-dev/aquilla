// Map hosted TTS / clone-conversion HTTP failures onto Error messages that
// name the engine that actually failed. The gutter tooltip shows
// `err.message` raw; categorizeAiError then turns the same strings into a
// titled popover so Inworld 503s never read as a missing Gemini key.

export const HOSTED_TTS_NOT_CONFIGURED_BODY =
  "This line uses Inworld TTS, not Gemini. Hosted TTS isn't wired on this server — a Gemini API key will not fix it."

export const HOSTED_TTS_FAILED_BODY =
  "Inworld TTS couldn't generate this line. This is not a Gemini key problem."

export const SEED_VC_NOT_CONFIGURED_BODY =
  "This clone voice needs Seed-VC after Gemini or a local engine. Voice conversion isn't wired on this server. An Inworld clone wouldn't need this step."

export const SEED_VC_FAILED_BODY =
  "Voice cloning (Seed-VC) couldn't convert this line. This is not a Gemini key problem."

export function errorFromHostedTts(status: number, body: string): Error {
  const detail = body.trim() || `HTTP ${status}`
  if (status === 503 && /tts not configured/i.test(detail)) {
    return new Error(HOSTED_TTS_NOT_CONFIGURED_BODY)
  }
  return new Error(`Inworld TTS failed (${status}): ${detail}`)
}

export function errorFromVoiceConvert(status: number, body: string): Error {
  const detail = body.trim() || `HTTP ${status}`
  if (status === 503 && /voice conversion not configured/i.test(detail)) {
    return new Error(SEED_VC_NOT_CONFIGURED_BODY)
  }
  return new Error(`Voice cloning (Seed-VC) failed (${status}): ${detail}`)
}
