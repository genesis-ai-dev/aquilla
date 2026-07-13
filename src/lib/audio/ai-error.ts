// Categorize raw AI-feature error strings (TTS, transcription) into one of a
// small set of failure modes that map cleanly to UI affordances. The mapping
// is heuristic — pattern-matched on messages we generate locally — but it
// keeps the user from having to read raw exception text to figure out what
// to do next.

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
  | "unknown"

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
  return { category: "unknown", title: "Couldn't generate", body: raw || "Something went wrong.", raw }
}
