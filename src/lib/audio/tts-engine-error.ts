// Map hosted TTS / clone-conversion HTTP failures onto Error messages that
// name the engine that actually failed. The gutter tooltip shows
// `err.message` raw; categorizeAiError then turns the same strings into a
// titled popover so Inworld 503s never read as a missing Gemini key.

export const HOSTED_TTS_NOT_CONFIGURED_BODY =
  "This line uses Inworld TTS, not Gemini. Hosted TTS isn't wired on this server, so a Gemini API key will not fix it."

export const HOSTED_TTS_FAILED_BODY =
  "Inworld TTS couldn't generate this line. This is not a Gemini key problem."

/**
 * AQU-1872: the sync-worker refuses synthesis with `429 credit_cap_exceeded`
 * once the org has spent its credit allowance. Without this branch that body
 * fell through to HOSTED_TTS_FAILED_BODY, which told the user the opposite of
 * the truth — "Inworld TTS couldn't generate this line" reads as a vendor
 * fault when in fact nothing was ever sent to the vendor, and the one person
 * who can clear it (an org admin, raising the cap) was never named.
 */
export const HOSTED_TTS_CREDIT_CAP_BODY =
  "This organization has used its AI credit allowance, so no audio was generated. This is not a Gemini key problem and the voice engine is fine — ask an org admin to raise the cap, or wait for the allowance to reset."

export const SEED_VC_NOT_CONFIGURED_BODY =
  "This clone voice needs Seed-VC after Gemini or a local engine. Voice conversion isn't wired on this server. An Inworld clone wouldn't need this step."

export const SEED_VC_FAILED_BODY =
  "Voice cloning (Seed-VC) couldn't convert this line. This is not a Gemini key problem."

/**
 * AQU-1156: a single TTS request must finish, or fail, inside a bounded window.
 * Without a deadline a hung upstream left the per-cell generate control
 * spinning until the browser's own multi-minute socket timeout — no audio, no
 * error, nothing to retry.
 *
 * The client bound sits ABOVE the sync-worker's own upstream bound
 * (`INWORLD_TTS_REQUEST_TIMEOUT_MS`, 60s) so the server's specific 502 normally
 * wins the race and the user reads *why* it failed; this is the backstop for
 * when the worker itself never answers.
 */
export const TTS_REQUEST_TIMEOUT_MS = 90_000

/** True for the DOMException an `AbortSignal.timeout`/abort rejects fetch with. */
export function isAbortTimeout(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false
  const name = (err as { name?: unknown }).name
  return name === "TimeoutError" || name === "AbortError"
}

/**
 * The message a blown deadline shows in the cell's tts badge. It names the
 * engine (so an Inworld stall never reads as a missing Gemini key) and says
 * the request is over, because the control is idle again and clickable.
 */
export function errorFromTtsTimeout(engine: string, ms: number): Error {
  return new Error(
    `${engine} did not respond within ${Math.round(ms / 1000)}s. The request was cancelled — click generate again to retry.`,
  )
}

export function errorFromHostedTts(status: number, body: string): Error {
  const detail = body.trim() || `HTTP ${status}`
  if (status === 503 && /tts not configured/i.test(detail)) {
    return new Error(HOSTED_TTS_NOT_CONFIGURED_BODY)
  }
  // AQU-1872: an org out of credit is refused before the vendor is called, so
  // it must not be reported as a vendor failure. The gutter tooltip shows
  // `err.message` raw, so this message has to stand on its own.
  if (status === 429 && /credit_cap_exceeded/i.test(detail)) {
    return new Error(HOSTED_TTS_CREDIT_CAP_BODY)
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
