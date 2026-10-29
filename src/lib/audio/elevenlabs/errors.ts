// ElevenLabs failures as Error messages (AQU-2299).
//
// The sync-worker answers every ElevenLabs failure with
// `{ error: "elevenlabs_<code>", message }` (sync-worker/src/elevenlabs-api.ts).
// Each code becomes an English message with a fixed `ElevenLabs (<reason>)`
// lead-in: the gutter tooltip shows `err.message` raw, and
// `categorizeAiError` (ai-error.ts) matches the lead-in to pick a localized
// title + body. The lead-ins are match keys — change them with the matcher.

export type ElevenLabsFailure =
  | "no key"
  | "invalid key"
  | "out of characters"
  | "cloning not allowed"
  | "rate limited"
  | "failed"

/** Matches the lead-in every ElevenLabs error message starts with. */
export const ELEVENLABS_ERROR_RE = /^elevenlabs \((no key|invalid key|out of characters|cloning not allowed|rate limited|failed)\)/i

export class ElevenLabsError extends Error {
  readonly failure: ElevenLabsFailure
  constructor(failure: ElevenLabsFailure, detail: string) {
    super(`ElevenLabs (${failure}): ${detail}`)
    this.name = "ElevenLabsError"
    this.failure = failure
  }
}

/** Thrown before any request when this device has no ElevenLabs key. */
export function elevenLabsKeyMissingError(): ElevenLabsError {
  return new ElevenLabsError("no key", "connect your ElevenLabs API key to use this voice.")
}

const CODE_TO_FAILURE: Record<string, ElevenLabsFailure> = {
  elevenlabs_key_missing: "no key",
  elevenlabs_invalid_key: "invalid key",
  elevenlabs_quota_exceeded: "out of characters",
  elevenlabs_clone_not_allowed: "cloning not allowed",
  elevenlabs_rate_limited: "rate limited",
}

/** Turn a non-OK /api/v1/elevenlabs/* response into an Error. */
export function errorFromElevenLabs(status: number, bodyText: string): Error {
  let code = ""
  let message = bodyText.trim()
  try {
    const parsed = JSON.parse(bodyText) as { error?: unknown; message?: unknown }
    if (typeof parsed.error === "string") code = parsed.error
    if (typeof parsed.message === "string") message = parsed.message
  } catch {
    // A plain-text worker refusal (bad request, auth) — keep the text.
  }
  const failure = CODE_TO_FAILURE[code]
  if (failure) return new ElevenLabsError(failure, message)
  // Our own per-user throttle, not ElevenLabs'.
  if (status === 429) return new ElevenLabsError("rate limited", message || `HTTP ${status}`)
  return new ElevenLabsError("failed", `${message || `HTTP ${status}`} (${status})`)
}
