// AQU-1596 — a file's declared languages are import information, never a
// lane's language.
//
// Import records the languages a file's header *claims*. That claim is worth
// keeping: it seeds text direction, and it lets import warn when someone drops
// a Spanish file into the French lane. It is not the language of the lane the
// rows land in, and reading it as one is what made the editor ignore the
// file's target outright (AQU-583) — a Macula file declares the corpus code
// `hbo`, and a translation imported into the French lane may well declare
// Spanish.
//
// So the keys now say what they are. New writes use `declaredSourceLanguage` /
// `declaredTargetLanguage`; reads accept the legacy `sourceLanguage` /
// `targetLanguage` and their snake_case aliases as declared values, because
// stored meta blobs are history and are never rewritten (AQU-1419). A writer
// leaves whatever legacy keys a blob already carries in place and adds the
// declared ones, which readers prefer — so a blob written by either side reads
// correctly on both.

/** The canonical meta key for the source language a file declared. */
export const DECLARED_SOURCE_LANGUAGE_KEY = 'declaredSourceLanguage'
/** The canonical meta key for the target language a file declared. */
export const DECLARED_TARGET_LANGUAGE_KEY = 'declaredTargetLanguage'

/**
 * Every meta key that has ever held a file's declared source language, in
 * read-preference order: the canonical key first, then the two legacy spellings
 * in the order the old readers tried them (snake_case before camelCase).
 */
export const DECLARED_SOURCE_LANGUAGE_KEYS = [
  DECLARED_SOURCE_LANGUAGE_KEY,
  'source_language',
  'sourceLanguage',
] as const

/** The target-side counterpart of `DECLARED_SOURCE_LANGUAGE_KEYS`. */
export const DECLARED_TARGET_LANGUAGE_KEYS = [
  DECLARED_TARGET_LANGUAGE_KEY,
  'target_language',
  'targetLanguage',
] as const

export interface DeclaredLanguages {
  /** What the file's header claimed it was translated FROM, or null. */
  declaredSourceLanguage: string | null
  /** What the file's header claimed it was translated INTO, or null. */
  declaredTargetLanguage: string | null
}

function objectRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/**
 * The first key in `keys` holding a non-blank string. A blank value is skipped
 * rather than returned, so an empty legacy `sourceLanguage` left behind by an
 * old write cannot mask a real `declaredSourceLanguage` written next to it.
 * The value is returned as stored — callers that need a normalized tag run it
 * through `normalizeLanguageTag` themselves.
 */
function firstDeclared(meta: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = meta[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  return null
}

/** Read both declared languages out of a `files.meta` blob (parsed or not). */
export function readDeclaredLanguages(meta: unknown): DeclaredLanguages {
  const record = objectRecord(meta)
  return {
    declaredSourceLanguage: firstDeclared(record, DECLARED_SOURCE_LANGUAGE_KEYS),
    declaredTargetLanguage: firstDeclared(record, DECLARED_TARGET_LANGUAGE_KEYS),
  }
}

/**
 * Record what a file declared on a meta blob under construction, mutating it
 * in place. Blank and absent values write nothing — exactly like the
 * `if (payload.sourceLanguage)` guards this replaces, so an import that names
 * no language cannot blank out a claim an earlier write recorded.
 */
export function assignDeclaredLanguages(
  meta: Record<string, unknown>,
  declaredSourceLanguage: unknown,
  declaredTargetLanguage: unknown,
): void {
  if (typeof declaredSourceLanguage === 'string' && declaredSourceLanguage.trim()) {
    meta[DECLARED_SOURCE_LANGUAGE_KEY] = declaredSourceLanguage
  }
  if (typeof declaredTargetLanguage === 'string' && declaredTargetLanguage.trim()) {
    meta[DECLARED_TARGET_LANGUAGE_KEY] = declaredTargetLanguage
  }
}
