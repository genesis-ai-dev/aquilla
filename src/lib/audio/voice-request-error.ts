// Voice Design and publish show `err.message` inline. Two failures arrive as
// machine text the user cannot act on:
//
//   * sync-worker collapses every Inworld throw to HTTP 502
//     "voice provider request failed" (the real status stays in the worker log).
//     The client wraps that as `Inworld TTS failed (502): voice provider request failed`.
//   * a missing or rejected session never reaches that request. The audio
//     sync-token fetcher swallows the 401 and the caller throws
//     `designInworldVoice: no sync token` / `publishInworldVoice: no sync token`.
//
// AQU-1755. Neither case is "click the translation sparkle first" — a signed-in
// session can design a voice without that. Name the thing that is actually
// missing and the click that comes next.

import { t } from "@/lib/i18n/standalone"

export function explainVoiceRequestError(raw: string): string {
  const message = raw.trim().toLowerCase()
  if (
    message.includes("no sync token") ||
    message.includes("invalid token") ||
    message.includes("missing token") ||
    message.includes("not authenticated") ||
    message.includes("unauthenticated")
  ) {
    return t("audio.newVoice.errorSignInRequired")
  }
  if (message.includes("voice provider request failed")) {
    return t("audio.newVoice.errorProviderFailed")
  }
  return raw
}
