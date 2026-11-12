// Voice corrections (AQU-1692): the `bibleVoiceOverrides` project setting.
//
// A maintainer corrects who speaks a pack speech, or to whom, for their
// project. The pack itself is never edited from Aquilla. Keyed by the pack's
// speech id ("sp:{firstWordId}-{lastWordId}"); a field left out keeps the
// pack's value. Each correction says who made it, when, and why.
//
// Pure and dependency-free, with relative imports only, so both workers can
// import it: the settings-key registry and the auth-worker's settings route
// refuse a malformed map, and the SPA reads a stored one leniently
// (src/lib/bible-data/voice-overrides.ts applies it to the voice index).
//
// Spec: aquilla-specs 05-user-stories/see-who-is-speaking.md and
// 04-features/bible-knowledge-layer.md ("Voice override").

export interface BibleVoiceOverride {
  /** The speaker's entity id (from the book's `people` layer). Absent keeps the pack's. */
  speaker?: string
  /** The addressee's entity id. Absent keeps the pack's. */
  addressee?: string
  /** Why, in the maintainer's words. Required. */
  note: string
  /** Who saved it: their username at the time. */
  by: string
  /** When, as an ISO time. */
  at: string
}

/** The stored shape: one correction per pack speech id. */
export type BibleVoiceOverrides = Record<string, BibleVoiceOverride>

const OVERRIDE_FIELDS = new Set(['speaker', 'addressee', 'note', 'by', 'at'])

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.trim() !== ''

/** A pack speech id. */
export function isSpeechId(id: string): boolean {
  return id.startsWith('sp:') && id.length > 3
}

/** Shown by describe_command("PatchSettings") and in validation errors. */
export const BIBLE_VOICE_OVERRIDES_TYPE_NAME =
  '{ [speechId: "sp:…"]: { speaker?: string, addressee?: string, note: string, by: string, at: string } }'

/**
 * Null when `entry` is one well-formed correction — it changes the speaker or
 * the addressee, and says why — else what is wrong with it.
 */
export function bibleVoiceOverrideProblem(entry: unknown, id = 'a speech'): string | null {
  if (!isPlainObject(entry)) return `the correction for ${id} must be an object`
  const unknown = Object.keys(entry).find((key) => !OVERRIDE_FIELDS.has(key))
  if (unknown !== undefined) return `the correction for ${id} has an unknown field "${unknown}"`
  if (entry.speaker !== undefined && !nonEmpty(entry.speaker)) return `the correction for ${id} has an empty speaker`
  if (entry.addressee !== undefined && !nonEmpty(entry.addressee)) return `the correction for ${id} has an empty addressee`
  if (entry.speaker === undefined && entry.addressee === undefined) {
    return `the correction for ${id} changes neither the speaker nor the addressee`
  }
  for (const field of ['note', 'by', 'at'] as const) {
    if (!nonEmpty(entry[field])) return `the correction for ${id} needs a non-empty "${field}"`
  }
  return null
}

/** One well-formed correction: it changes the speaker or the addressee, and says why. */
export function isBibleVoiceOverride(value: unknown): value is BibleVoiceOverride {
  return bibleVoiceOverrideProblem(value) === null
}

/**
 * Null when the whole map is well-formed, else what is wrong with it. Writers
 * are held to this: the settings-key registry and the settings route both
 * refuse a map with a problem.
 */
export function bibleVoiceOverridesProblem(value: unknown): string | null {
  if (!isPlainObject(value)) return 'bibleVoiceOverrides must be an object keyed by speech id'
  for (const [id, entry] of Object.entries(value)) {
    if (!isSpeechId(id)) return `"${id}" is not a speech id ("sp:…")`
    const problem = bibleVoiceOverrideProblem(entry, `"${id}"`)
    if (problem) return problem
  }
  return null
}

/** The whole map is well-formed. Writers are held to this. */
export function isBibleVoiceOverrides(value: unknown): value is BibleVoiceOverrides {
  return bibleVoiceOverridesProblem(value) === null
}

/** A stored map as readers take it: malformed entries are dropped, never thrown on. */
export function readBibleVoiceOverrides(raw: unknown): BibleVoiceOverrides {
  if (!isPlainObject(raw)) return {}
  const out: BibleVoiceOverrides = {}
  for (const [id, entry] of Object.entries(raw)) {
    if (isSpeechId(id) && isBibleVoiceOverride(entry)) out[id] = entry
  }
  return out
}
