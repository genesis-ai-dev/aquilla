// Categorize raw AI-feature error strings (TTS, transcription, drafting,
// agent runs) into one of a small set of failure modes that map cleanly to UI
// affordances. The mapping is heuristic — pattern-matched on messages we
// generate locally — but it keeps the user from having to read raw exception
// text to figure out what to do next.
//
// AQU-891: every branch must produce a `body` the user can act on WITHOUT
// reading `raw`. When we can't improve on the raw text we still say something
// plain-language and leave the verbatim message to the "Technical detail"
// disclosure — a raw provider payload (an OpenRouter 413 JSON blob, say) is
// never the primary message.
//
// `title` is translated via `t()` from src/lib/i18n/standalone.ts (this
// module has no React tree to call the useT() hook from, and each `title` is
// a fresh value computed per call, not frozen module-scope data — see that
// module's header). The `m.includes(...)` pattern matching below stays keyed
// against ENGLISH substrings deliberately: `rawMessage` is diagnostic text
// produced elsewhere in the app and by upstream providers, most of which is
// never itself translated, so the matches must not be run through `t()`.

import { t } from "@/lib/i18n/standalone"
import {
  OMNIVOICE_FAILED_BODY,
  OMNIVOICE_NOT_CONFIGURED_BODY,
  SEED_VC_FAILED_BODY,
  SEED_VC_NOT_CONFIGURED_BODY,
} from "./tts-engine-error"

export type ErrorCategory =
  | "missing-gemini-key"
  | "gemini-failed"
  | "omnivoice-not-configured"
  | "omnivoice-failed"
  | "seed-vc-not-configured"
  | "seed-vc-failed"
  | "consent-denied"
  | "no-source-text"
  | "translation-not-configured"
  | "tts-not-configured"
  | "translation-failed"
  | "git-project-unsupported"
  | "sign-in-required"
  | "network"
  | "model-load-failed"
  | "audio-format-unsupported"
  | "daily-quota-exceeded"
  | "model-not-allowed"
  | "request-too-large"
  | "rate-limited"
  | "timed-out"
  | "provider-unavailable"
  | "provider-rejected"
  | "unknown"

/** Pull an HTTP status out of the messages we format locally, e.g.
 *  `Completion failed: 413 {"error":…}` or `voice/tts failed (503): …`.
 *  Deliberately anchored to a "failed/error/status/http" lead-in so a bare
 *  three-digit number inside a provider payload isn't mistaken for a status.
 *
 *  THE OPTIONAL PARENTHESIS IS NOT COSMETIC. Every audio error this app
 *  formats writes the status in brackets — `voice/tts failed (503)`,
 *  `audio upload failed (500)`, `voice convert failed (502)`, `Gemini TTS
 *  failed (500)` — and without the `\(?` none of them parsed. Only the
 *  completions path's bare `failed: 413` did. So the `rate-limited`,
 *  `provider-unavailable` and `provider-rejected` branches below had never
 *  once fired for an audio failure: every one of them fell through to
 *  `unknown`, which is why a voice failure read as a raw server fragment
 *  however carefully those branches were worded. */
function extractStatus(lowered: string): number | null {
  const match = lowered.match(/(?:failed|error|status|http)[:\s]+\(?(\d{3})\b/)
  return match ? Number(match[1]) : null
}

export interface ActionableError {
  category: ErrorCategory
  /** One-line heading for the popover. Plain English, no jargon. */
  title: string
  /** Full explanatory body. Falls back to the raw message when we can't
   *  improve on it. */
  body: string
  raw: string
}

export function categorizeAiError(rawMessage: string): ActionableError {
  const raw = rawMessage.trim()
  const m = raw.toLowerCase()
  const status = extractStatus(m)

  // Platform daily quota (AQU-265): 429 responses from the Frontier/Aquilla proxy.
  if (
    m.includes("daily ai limit") ||
    m.includes("daily_budget_exceeded") ||
    // The TTS budget's own code, which reaches us as a raw JSON body:
    // `voice/tts failed (429): {"error":"tts_daily_limit_exceeded"}`. Without
    // this it matched nothing here, and `looksLikeMachineDump` saw the braces
    // and swapped the whole thing for "the AI request didn't finish" — the
    // one failure where the user CAN do something (wait, or switch provider)
    // wearing the one message that says nothing at all.
    m.includes("daily_limit_exceeded") ||
    m.includes("resets at midnight") ||
    m.includes("global_budget_exceeded") ||
    m.includes("platform ai capacity")
  ) {
    return {
      category: "daily-quota-exceeded",
      title: t("audio.aiError.dailyLimitTitle"),
      body: "Daily AI limit reached — resets at midnight UTC. Try again tomorrow, or switch this project to a custom AI provider.",
      raw,
    }
  }
  // Model not on the platform allowlist.
  if (m.includes("model_not_allowed") || m.includes("not available on this platform")) {
    return {
      category: "model-not-allowed",
      title: t("audio.aiError.modelNotAvailableTitle"),
      body: raw,
      raw,
    }
  }

  // Prompt exceeded the model's context window (AQU-891). OpenRouter answers
  // 413 with a "request too large for model" payload; other providers phrase
  // it as a context-length error. Checked early because the payload often also
  // mentions "model", which later heuristics would misread.
  if (
    status === 413 ||
    m.includes("request too large") ||
    m.includes("too large for model") ||
    m.includes("context length") ||
    m.includes("context_length_exceeded") ||
    m.includes("maximum context")
  ) {
    return {
      category: "request-too-large",
      title: t("audio.aiError.tooLargeTitle"),
      body: "This request was larger than the selected model can handle. Draft fewer cells at once, lower the number of examples in AI settings, or pick a model with a larger context window.",
      raw,
    }
  }

  // Hosted TTS / clone conversion — name the engine BEFORE the Gemini-key
  // heuristic. A local sync-worker 503 ("TTS not configured") is OmniVoice,
  // not a missing Google key; sending people to Gemini settings is a lie.
  if (
    m.includes("this line uses omnivoice") ||
    m.includes("tts not configured") ||
    (m.includes("voice/tts") && (status === 503 || m.includes("not configured")))
  ) {
    return {
      category: "omnivoice-not-configured",
      title: t("audio.aiError.omnivoiceNotConfiguredTitle"),
      body: OMNIVOICE_NOT_CONFIGURED_BODY,
      raw,
    }
  }
  if (
    m.includes("omnivoice tts failed") ||
    m.includes("omnivoice couldn't generate") ||
    m.includes("voice/tts failed")
  ) {
    return {
      category: "omnivoice-failed",
      title: t("audio.aiError.omnivoiceFailedTitle"),
      body: OMNIVOICE_FAILED_BODY,
      raw,
    }
  }
  if (
    m.includes("this clone voice needs seed-vc") ||
    m.includes("voice conversion not configured")
  ) {
    return {
      category: "seed-vc-not-configured",
      title: t("audio.aiError.seedVcNotConfiguredTitle"),
      body: SEED_VC_NOT_CONFIGURED_BODY,
      raw,
    }
  }
  if (
    m.includes("voice cloning (seed-vc) failed") ||
    m.includes("voice cloning (seed-vc) couldn't") ||
    m.includes("voice convert failed")
  ) {
    return {
      category: "seed-vc-failed",
      title: t("audio.aiError.seedVcFailedTitle"),
      body: SEED_VC_FAILED_BODY,
      raw,
    }
  }

  if (m.includes("api key") || m.includes("api_key") || m.includes("apikey") ||
      (m.includes("gemini") && m.includes("key"))) {
    return {
      category: "missing-gemini-key",
      title: t("audio.aiError.geminiKeyRequiredTitle"),
      body: "Add a Gemini API key to use this Gemini voice, or switch the line to OmniVoice (hosted, no key) or a local engine (Kokoro or MMS).",
      raw,
    }
  }
  if (m.includes("gemini tts failed") || (m.includes("gemini") && m.includes("did not include audio"))) {
    return {
      category: "gemini-failed",
      title: t("audio.aiError.geminiFailedTitle"),
      body: "Gemini couldn't generate this line. Check the API key, or switch this voice to OmniVoice.",
      raw,
    }
  }
  if (m.includes("sign in") || m.includes("not authenticated") || m.includes("unauthenticated")) {
    return { category: "sign-in-required", title: t("audio.aiError.signInRequiredTitle"), body: raw, raw }
  }
  if (m.includes("git project")) {
    return {
      category: "git-project-unsupported",
      title: t("audio.aiError.gitProjectUnsupportedTitle"),
      body: raw,
      raw,
    }
  }
  if (m.includes("no source text") || m.includes("no text to synthesize")) {
    return { category: "no-source-text", title: t("audio.aiError.nothingToReadTitle"), body: raw, raw }
  }
  if (m.includes("translation isn't configured") || m.includes("translation is not configured")) {
    return {
      category: "translation-not-configured",
      title: t("audio.aiError.translationNotConfiguredTitle"),
      body: "Set up a completion provider for this project before generating voice on untranslated cells.",
      raw,
    }
  }
  // NOT SET UP IS NOT A TEMPORARY OUTAGE, and the ordering here is the whole
  // point: the server answers 503 for this, so with `extractStatus` finally
  // parsing brackets the branch below would call it `provider-unavailable` and
  // say "this is usually temporary — try again in a moment." It is not
  // temporary and retrying will never fix it. Since OmniVoice is the DEFAULT
  // engine, that would be the wrong advice on the single most likely voice
  // failure in the app.
  //
  // Matched on the specific server strings rather than a bare "not
  // configured": this module also categorizes drafting and agent failures,
  // and telling someone their *translation* provider is a voice problem would
  // be its own small lie.
  if (
    m.includes("tts not configured") ||
    m.includes("voice conversion not configured") ||
    m.includes("voice generation not configured")
  ) {
    return {
      category: "tts-not-configured",
      title: t("audio.aiError.ttsNotConfiguredTitle"),
      // Worded to follow its own title rather than repeat it — the recorder
      // renders the two as one sentence.
      body: "Switch this project to a local voice (Kokoro or MMS), which runs in the browser, or ask an administrator to configure the server voice service.",
      raw,
    }
  }
  if (m.startsWith("translation failed") || m.includes("translation failed:") || m.includes("translation produced no text")) {
    return { category: "translation-failed", title: t("audio.aiError.translationFailedTitle"), body: raw, raw }
  }
  if (
    m.includes("network") ||
    m.includes("fetch failed") ||
    m.includes("offline") ||
    m.includes("failed to fetch") ||
    m.includes("err_internet")
  ) {
    return {
      category: "network",
      title: t("audio.aiError.networkTitle"),
      body: "Check your connection and try again. Local voices keep working offline once their model is downloaded.",
      raw,
    }
  }
  if ((m.includes("model") && (m.includes("download") || m.includes("load") || m.includes("fetch"))) ||
      m.includes("transformers")) {
    return {
      category: "model-load-failed",
      title: t("audio.aiError.modelLoadFailedTitle"),
      body: raw,
      raw,
    }
  }
  if (m.includes("decode") || m.includes("audio format") || m.includes("unsupported audio")) {
    return {
      category: "audio-format-unsupported",
      title: t("audio.aiError.audioFormatUnsupportedTitle"),
      body: "Try uploading a .wav, .mp3, or .ogg file.",
      raw,
    }
  }
  if (m.includes("timed out") || m.includes("timeout")) {
    return {
      category: "timed-out",
      title: t("audio.aiError.timedOutTitle"),
      body: "The AI provider took too long to respond. Try again — if it keeps happening, send a smaller request or switch models.",
      raw,
    }
  }
  // Provider rate limit that isn't our own daily budget (handled far above).
  if (status === 429 || m.includes("rate limit") || m.includes("too many requests")) {
    return {
      category: "rate-limited",
      title: t("audio.aiError.rateLimitedTitle"),
      body: "The AI provider is rate-limiting requests. Wait a moment and try again.",
      raw,
    }
  }
  if (status !== null && status >= 500) {
    return {
      category: "provider-unavailable",
      title: t("audio.aiError.providerUnavailableTitle"),
      body: "The AI provider returned a server error. This is usually temporary — try again in a moment.",
      raw,
    }
  }
  if (status !== null && status >= 400) {
    return {
      category: "provider-rejected",
      title: t("audio.aiError.providerRejectedTitle"),
      body: "The request didn't reach a model. Open the technical detail below and copy it to support if this keeps happening.",
      raw,
    }
  }
  // Uncategorized. Most of these are messages we wrote ourselves and are
  // already plain language — keep showing them. Only a machine dump (a JSON
  // payload, a stack, a wall of text) gets swapped for the generic line, with
  // the verbatim text left to the "Technical detail" disclosure.
  if (!raw || looksLikeMachineDump(raw)) {
    return {
      category: "unknown",
      title: t("audio.aiError.unknownTitle"),
      body: "The AI request didn't finish. Open the technical detail below and copy it to support if this keeps happening.",
      raw,
    }
  }
  return { category: "unknown", title: t("audio.aiError.unknownTitle"), body: raw, raw }
}

/** Heuristic: does this read as a payload/stack rather than a sentence we'd
 *  be happy showing a translator? */
function looksLikeMachineDump(raw: string): boolean {
  return (
    raw.length > 180 ||
    /[{}[\]]/.test(raw) ||
    /\bat\s+\S+\s*\(/.test(raw) || // stack frame
    /\b[a-z_]+_[a-z_]+\b/.test(raw) // snake_case machine code, e.g. invalid_request_error
  )
}
