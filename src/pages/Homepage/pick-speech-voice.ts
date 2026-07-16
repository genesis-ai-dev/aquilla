// Picks the most natural-sounding browser Web Speech voice for the homepage
// "Hear it" demo. The default voice returned by `speechSynthesis` on most
// systems is a low-quality on-device engine (eSpeak on Linux, "compact" voices
// on older OSes) that sounds robotic — the "Stephen Hawking" complaint in
// AQU-246. Given the list from `speechSynthesis.getVoices()`, rank the
// candidates so the demo speaks in the best voice the visitor's browser
// actually offers, degrading gracefully when only a basic engine is installed.

// Name/URI fragments that mark a higher-quality (usually neural/cloud) voice.
const NATURAL_MARKERS = [
  "natural", "neural", "wavenet", "enhanced", "premium", "online", "google", "siri",
]

// Fragments that mark the low-quality, robotic on-device engines.
const ROBOTIC_MARKERS = ["espeak", "e-speak", "compact", "pico", "flite", "festival"]

function baseLang(tag: string | undefined): string {
  return (tag ?? "").toLowerCase().split(/[-_]/)[0]
}

function scoreVoice(voice: SpeechSynthesisVoice, base: string): number {
  const hay = `${voice.name ?? ""} ${voice.voiceURI ?? ""}`.toLowerCase()
  let score = 0
  // Network/cloud voices are markedly more natural than the on-device defaults.
  if (voice.localService === false) score += 3
  if (NATURAL_MARKERS.some((m) => hay.includes(m))) score += 4
  if (ROBOTIC_MARKERS.some((m) => hay.includes(m))) score -= 5
  // A region-qualified match for the requested language (e.g. "es-ES") reads as
  // a deliberate localized voice rather than a generic language fallback.
  if (base && voice.lang?.toLowerCase().startsWith(`${base}-`)) score += 1
  return score
}

/**
 * Choose the most natural-sounding voice for `lang` from the browser's list.
 * Prefers voices whose language matches `lang`; falls back to the whole list
 * when the language is unavailable. Returns `undefined` only when no voices
 * exist — the caller then lets the browser pick its own default.
 */
export function pickNaturalVoice(
  voices: readonly SpeechSynthesisVoice[] | undefined,
  lang: string,
): SpeechSynthesisVoice | undefined {
  if (!voices || voices.length === 0) return undefined
  const base = baseLang(lang)
  const matches = base ? voices.filter((v) => baseLang(v.lang) === base) : []
  const pool = matches.length ? matches : voices
  let best: SpeechSynthesisVoice | undefined
  let bestScore = -Infinity
  for (const voice of pool) {
    const score = scoreVoice(voice, base)
    // Strict `>` keeps the first candidate on a tie — stable, and matches the
    // original `Array.find` ordering the demo relied on.
    if (score > bestScore) {
      bestScore = score
      best = voice
    }
  }
  return best
}
