/**
 * translator-profile.ts — user-level translator profile.
 *
 * A per-user profile describing the translator (fallback response language + demographics)
 * that is injected as JSON into the AI chat and agent system prompts so summaries
 * and answers are tailored to them. Conversation otherwise follows the language
 * of the user's latest message.
 *
 * STORAGE: device-scoped localStorage today, behind this module's
 * get/set/subscribe boundary. Server-sync progression path: persist under
 * `users.preferences.translatorProfile` (a PATCH /auth/me) and hydrate from
 * /auth/me — only this module's internals change; callers (useTranslatorProfile,
 * chat-service, AgentDockView) stay the same.
 *
 * Mirrors the analytics-consent.ts idiom (localStorage + a CustomEvent so every
 * hook instance in the tab stays in sync).
 */

const STORAGE_KEY = "codex:translatorProfile"
const CHANGE_EVENT = "codex:translator-profile-changed"

/** Max characters per free-text field before it is stored / sent to the model. */
export const MAX_PROFILE_FIELD_CHARS = 280

export interface TranslatorProfile {
  /** Fallback reply language for messages whose language is ambiguous, e.g. "Tagalog". */
  responseLanguage?: string
  age?: string
  gender?: string
  educationLevel?: string
  religiousBackground?: string
  translationExperience?: string
  geographicalSetting?: string
  /** "Other relevant information" free-text from the slide. */
  otherInfo?: string
}

/** Field order is also the render order in the editor and the prompt JSON. */
export const PROFILE_FIELDS: (keyof TranslatorProfile)[] = [
  "responseLanguage",
  "age",
  "gender",
  "educationLevel",
  "religiousBackground",
  "translationExperience",
  "geographicalSetting",
  "otherInfo",
]

export function getTranslatorProfile(): TranslatorProfile {
  if (typeof window === "undefined") return {}
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object") return {}
    return sanitizeProfile(parsed as TranslatorProfile)
  } catch {
    return {}
  }
}

export function setTranslatorProfile(profile: TranslatorProfile): void {
  if (typeof window === "undefined") return
  const clean = sanitizeProfile(profile)
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(clean))
  } catch {
    // Storage full/unavailable — the in-tab event below still updates live hooks.
  }
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: clean }))
}

export function onTranslatorProfileChange(handler: (p: TranslatorProfile) => void): () => void {
  if (typeof window === "undefined") return () => {}
  const listener = (e: Event) => handler((e as CustomEvent<TranslatorProfile>).detail)
  window.addEventListener(CHANGE_EVENT, listener)
  return () => window.removeEventListener(CHANGE_EVENT, listener)
}

/** Trim, cap, and drop empty fields. Applied on write and before any model send. */
export function sanitizeProfile(profile: TranslatorProfile | null | undefined): TranslatorProfile {
  const out: TranslatorProfile = {}
  if (!profile) return out
  for (const key of PROFILE_FIELDS) {
    const v = profile[key]
    if (typeof v !== "string") continue
    const trimmed = v.trim().slice(0, MAX_PROFILE_FIELD_CHARS)
    if (trimmed) out[key] = trimmed
  }
  return out
}

/** True when the profile has no usable fields after sanitizing. */
export function isProfileEmpty(profile: TranslatorProfile | null | undefined): boolean {
  return Object.keys(sanitizeProfile(profile)).length === 0
}

/**
 * The profile object to embed (as JSON) in a system prompt, or null when empty.
 * Same sanitize as write — callers never re-apply the rules.
 */
export function profileForPrompt(profile: TranslatorProfile | null | undefined): TranslatorProfile | null {
  const clean = sanitizeProfile(profile)
  return Object.keys(clean).length ? clean : null
}

/**
 * Resolve the fallback language for an ambiguous conversational message.
 * Precedence (approved): the user's profile language wins; the project's
 * `main_chat_language` is the fallback; otherwise undefined (model default).
 */
export function effectiveResponseLanguage(
  profile: TranslatorProfile | null | undefined,
  projectChatLanguage?: string | null,
): string | undefined {
  const fromProfile = sanitizeProfile(profile).responseLanguage
  const fallback = projectChatLanguage?.trim()
  return fromProfile || fallback || undefined
}

/**
 * The system-prompt fragment describing the translator + fallback reply language.
 * Returns "" when there is nothing to say. JSON-encodes the profile so the model
 * gets unambiguous key/values.
 *
 * MIRROR: auth-worker/src/lib/agent/schema-card.ts has a server-side copy of this
 * (the agent builds its prompt on the worker). Keep the heading text and shape in
 * sync — same reason protocol.ts mirrors the wire types.
 */
export function translatorProfilePromptBlock(
  profile: TranslatorProfile | null | undefined,
  responseLanguage?: string,
): string {
  const clean = profileForPrompt(profile)
  const language = (responseLanguage ?? "").trim()
  if (!clean && !language) return ""
  let block = ""
  if (clean) {
    block +=
      `\n\n## Translator profile (the person you are assisting — tailor depth, examples, and application to them)\n` +
      JSON.stringify(clean, null, 2)
  }
  if (language) {
    block += `\n\nUse ${language} only as the fallback conversation language when the user's recent messages are too ambiguous to identify their language. Otherwise, reply in the language the user just used.`
  }
  return block
}
