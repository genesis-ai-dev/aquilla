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

export type ErrorCategory =
  | "missing-gemini-key"
  | "consent-denied"
  | "no-source-text"
  | "translation-not-configured"
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
 *  `Completion failed: 413 {"error":…}` or `Failed to fetch models: 500 …`.
 *  Deliberately anchored to a "failed/error/status/http" lead-in so a bare
 *  three-digit number inside a provider payload isn't mistaken for a status. */
function extractStatus(lowered: string): number | null {
  const match = lowered.match(/(?:failed|error|status|http)[:\s]+(\d{3})\b/)
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
    m.includes("resets at midnight") ||
    m.includes("global_budget_exceeded") ||
    m.includes("platform ai capacity")
  ) {
    return {
      category: "daily-quota-exceeded",
      title: "Daily AI limit reached",
      body: "Daily AI limit reached — resets at midnight UTC. Try again tomorrow, or switch this project to a custom AI provider.",
      raw,
    }
  }
  // Model not on the platform allowlist.
  if (m.includes("model_not_allowed") || m.includes("not available on this platform")) {
    return {
      category: "model-not-allowed",
      title: "Model not available",
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
      title: "Too much text for this model",
      body: "This request was larger than the selected model can handle. Draft fewer cells at once, lower the number of examples in AI settings, or pick a model with a larger context window.",
      raw,
    }
  }

  if (m.includes("api key") || m.includes("api_key") || m.includes("apikey") ||
      m.includes("gemini") && m.includes("key")) {
    return {
      category: "missing-gemini-key",
      title: "Gemini API key required",
      body: "Add your Gemini API key to use Gemini voices, or switch this project to a local TTS provider (Kokoro or MMS).",
      raw,
    }
  }
  if (m.includes("sign in") || m.includes("not authenticated") || m.includes("unauthenticated")) {
    return { category: "sign-in-required", title: "Sign in required", body: raw, raw }
  }
  if (m.includes("git project")) {
    return { category: "git-project-unsupported", title: "Not yet supported on git projects", body: raw, raw }
  }
  if (m.includes("no source text") || m.includes("no text to synthesize")) {
    return { category: "no-source-text", title: "Nothing to read aloud", body: raw, raw }
  }
  if (m.includes("translation isn't configured") || m.includes("translation is not configured")) {
    return {
      category: "translation-not-configured",
      title: "Translation not configured",
      body: "Set up a completion provider for this project before generating voice on untranslated cells.",
      raw,
    }
  }
  if (m.startsWith("translation failed") || m.includes("translation failed:") || m.includes("translation produced no text")) {
    return { category: "translation-failed", title: "Translation failed", body: raw, raw }
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
      title: "Network error",
      body: "Check your connection and try again. Local voices keep working offline once their model is downloaded.",
      raw,
    }
  }
  if ((m.includes("model") && (m.includes("download") || m.includes("load") || m.includes("fetch"))) ||
      m.includes("transformers")) {
    return {
      category: "model-load-failed",
      title: "Couldn't load model",
      body: raw,
      raw,
    }
  }
  if (m.includes("decode") || m.includes("audio format") || m.includes("unsupported audio")) {
    return {
      category: "audio-format-unsupported",
      title: "Audio format not supported",
      body: "Try uploading a .wav, .mp3, or .ogg file.",
      raw,
    }
  }
  if (m.includes("timed out") || m.includes("timeout")) {
    return {
      category: "timed-out",
      title: "The request timed out",
      body: "The AI provider took too long to respond. Try again — if it keeps happening, send a smaller request or switch models.",
      raw,
    }
  }
  // Provider rate limit that isn't our own daily budget (handled far above).
  if (status === 429 || m.includes("rate limit") || m.includes("too many requests")) {
    return {
      category: "rate-limited",
      title: "Too many requests right now",
      body: "The AI provider is rate-limiting requests. Wait a moment and try again.",
      raw,
    }
  }
  if (status !== null && status >= 500) {
    return {
      category: "provider-unavailable",
      title: "The AI service is unavailable",
      body: "The AI provider returned a server error. This is usually temporary — try again in a moment.",
      raw,
    }
  }
  if (status !== null && status >= 400) {
    return {
      category: "provider-rejected",
      title: "The AI provider rejected this request",
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
      title: "Something went wrong",
      body: "The AI request didn't finish. Open the technical detail below and copy it to support if this keeps happening.",
      raw,
    }
  }
  return { category: "unknown", title: "Something went wrong", body: raw, raw }
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
