// Language-profile slots added by AQU-1691: their shapes and validators.
//
// Each slot validates on its own. A validator returns null when the value is
// fine, else a message naming the field at fault, which PatchSettings shows
// to an agent. ./language-profile.ts registers every slot and owns the
// whole-profile reader and validator.
//
// Bounds keep each slot small: autopilot puts the whole profile in every
// draft prompt, and a check reads it for every cell.
//
// Relative imports only, no DOM: both workers import this file.

/** Most entries in one list (forms, particles, verbs, negators). */
export const MAX_SLOT_LIST_ITEMS = 40
/** Longest entry in a list, and longest name, in characters. */
export const MAX_SLOT_ITEM_CHARS = 60
/** Longest free-text note, in characters. */
export const MAX_SLOT_NOTE_CHARS = 500
/** Most honorific levels a profile records. */
export const MAX_HONORIFIC_LEVELS = 8
/** Most explicit number words. */
export const MAX_NUMBER_WORDS = 200

/** How the language marks a question besides a question mark. */
export interface QuestionMarkersProfile {
  /** Word endings that make a question, without a hyphen: Finnish "ko" in "onko". */
  suffix?: string[]
  /** Separate words that make a question: Mandarin 吗, Japanese か. */
  particles?: string[]
}

export interface PronounsProfile {
  /** Does "you" change between one person and several? */
  secondPerson?: { numberDistinction: boolean; singular?: string[]; plural?: string[] }
  /** Is "we, including you" different from "we, not you"? */
  firstPersonPlural?: { clusivity: boolean; inclusive?: string[]; exclusive?: string[] }
  /** Numbers beyond one and many, each with its forms. */
  extraNumbers?: {
    dual?: boolean
    trial?: boolean
    paucal?: boolean
    dualForms?: string[]
    trialForms?: string[]
    paucalForms?: string[]
  }
  /** Does the third person mark gender or noun class? */
  thirdPerson?: { genderOrClass: boolean; forms?: string[] }
  /** Named levels of respect, each with its forms: familiar, polite, royal. */
  honorifics?: { levels: { name: string; forms?: string[] }[] }
}

/** "cldr": the standard spell-out rules for the language. Otherwise number → word, e.g. { "12": "twelve" }. */
export type NumberWordsProfile = 'cldr' | Record<string, string>

export interface KinTermsProfile {
  /** Kin terms must say who is older, e.g. Indonesian kakak / adik. */
  relativeAgeDistinction: boolean
  notes?: string
}

export interface DivineNamesProfile {
  /** How the divine name YHWH is rendered, e.g. "the LORD". */
  yhwh?: string
  /** Pronouns that refer to God start with a capital letter. */
  deityPronounCapitalization?: boolean
  /** κύριος used of Jesus, e.g. "Lord". */
  kyriosJesus?: string
  /** κύριος used of God, e.g. "the Lord". */
  kyriosGod?: string
}

/** Units such as cubits and denarii. */
export const MEASURES_STRATEGIES = ['convert', 'transliterate', 'mixed'] as const
export type MeasuresStrategy = (typeof MEASURES_STRATEGIES)[number]

/** Verses that some manuscripts leave out. */
export const TEXTUAL_VARIANT_POLICIES = ['omit', 'bracket', 'footnote'] as const
export type TextualVariantPolicy = (typeof TEXTUAL_VARIANT_POLICIES)[number]

/** Section headings above passages. */
export const HEADING_POLICIES = ['none', 'pericope'] as const
export type HeadingPolicy = (typeof HEADING_POLICIES)[number]

// ── Field checks ────────────────────────────────────────────────────────────

type FieldCheck = (value: unknown, path: string) => string | null

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function charCount(value: string): number {
  return Array.from(value).length
}

const bool: FieldCheck = (value, path) => (typeof value === 'boolean' ? null : `${path} must be true or false`)

/** Text that is not empty after trimming, up to `max` characters. */
function text(max: number): FieldCheck {
  return (value, path) =>
    typeof value === 'string' && value.trim() !== '' && charCount(value) <= max
      ? null
      : `${path} must be text of 1 to ${max} characters`
}

/**
 * A list of distinct, trimmed entries. Checks match entries character by
 * character, so a stray space or an empty entry could never match.
 */
function list(options: { noSpaces?: boolean } = {}): FieldCheck {
  return (value, path) => {
    if (!Array.isArray(value) || value.length > MAX_SLOT_LIST_ITEMS) {
      return `${path} must be a list of at most ${MAX_SLOT_LIST_ITEMS} entries`
    }
    for (const [index, item] of value.entries()) {
      if (typeof item !== 'string' || item === '' || item !== item.trim() || charCount(item) > MAX_SLOT_ITEM_CHARS) {
        return `${path}[${index}] must be trimmed text of 1 to ${MAX_SLOT_ITEM_CHARS} characters`
      }
      if (options.noSpaces && /\s/u.test(item)) return `${path}[${index}] must not contain spaces`
    }
    if (new Set(value).size !== value.length) return `${path} lists an entry twice`
    return null
  }
}

/** A plain object with only the named fields, each passing its check. */
function fields(
  path: string,
  value: unknown,
  checks: Readonly<Record<string, FieldCheck>>,
  required: readonly string[] = [],
): string | null {
  if (!isPlainObject(value)) return `${path} must be an object`
  for (const key of Object.keys(value)) {
    if (!Object.prototype.hasOwnProperty.call(checks, key)) return `${path} has an unknown field "${key}"`
  }
  for (const key of required) {
    if (value[key] === undefined) return `${path}.${key} is required`
  }
  for (const [key, check] of Object.entries(checks)) {
    if (value[key] === undefined) continue
    const problem = check(value[key], `${path}.${key}`)
    if (problem) return problem
  }
  return null
}

function nested(checks: Readonly<Record<string, FieldCheck>>, required: readonly string[] = []): FieldCheck {
  return (value, path) => fields(path, value, checks, required)
}

function oneOf(values: readonly string[]): FieldCheck {
  return (value, path) =>
    typeof value === 'string' && values.includes(value) ? null : `${path} must be one of ${values.join(', ')}`
}

// ── Slot validators ─────────────────────────────────────────────────────────

/** `{}` is a real answer: the language marks questions with a question mark only. */
export function questionMarkersProblem(value: unknown): string | null {
  return fields('questionMarkers', value, { suffix: list({ noSpaces: true }), particles: list() })
}

const honorificLevels: FieldCheck = (value, path) => {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_HONORIFIC_LEVELS) {
    return `${path} must list 1 to ${MAX_HONORIFIC_LEVELS} levels`
  }
  for (const [index, level] of value.entries()) {
    const problem = fields(`${path}[${index}]`, level, { name: text(MAX_SLOT_ITEM_CHARS), forms: list() }, ['name'])
    if (problem) return problem
  }
  return null
}

export function pronounsProblem(value: unknown): string | null {
  const problem = fields('pronouns', value, {
    secondPerson: nested({ numberDistinction: bool, singular: list(), plural: list() }, ['numberDistinction']),
    firstPersonPlural: nested({ clusivity: bool, inclusive: list(), exclusive: list() }, ['clusivity']),
    extraNumbers: nested({
      dual: bool,
      trial: bool,
      paucal: bool,
      dualForms: list(),
      trialForms: list(),
      paucalForms: list(),
    }),
    thirdPerson: nested({ genderOrClass: bool, forms: list() }, ['genderOrClass']),
    honorifics: nested({ levels: honorificLevels }, ['levels']),
  })
  if (problem) return problem
  // An empty inventory says nothing, so it cannot switch a check on.
  return Object.keys(value as Record<string, unknown>).length === 0 ? 'pronouns needs at least one part' : null
}

export function negatorsProblem(value: unknown): string | null {
  return list()(value, 'negators')
}

export function speechVerbsProblem(value: unknown): string | null {
  return list()(value, 'speechVerbs')
}

export function numberWordsProblem(value: unknown): string | null {
  if (value === 'cldr') return null
  if (!isPlainObject(value)) return 'numberWords must be "cldr" or a map from numbers to words'
  const entries = Object.entries(value)
  if (entries.length < 1 || entries.length > MAX_NUMBER_WORDS) {
    return `numberWords must map 1 to ${MAX_NUMBER_WORDS} numbers`
  }
  for (const [number, word] of entries) {
    if (!/^\d{1,9}$/.test(number)) return `numberWords has a key "${number}" that is not a whole number`
    const problem = text(MAX_SLOT_ITEM_CHARS)(word, `numberWords["${number}"]`)
    if (problem) return problem
  }
  return null
}

export function kinTermsProblem(value: unknown): string | null {
  return fields('kinTerms', value, { relativeAgeDistinction: bool, notes: text(MAX_SLOT_NOTE_CHARS) }, [
    'relativeAgeDistinction',
  ])
}

export function divineNamesProblem(value: unknown): string | null {
  const problem = fields('divineNames', value, {
    yhwh: text(MAX_SLOT_ITEM_CHARS),
    deityPronounCapitalization: bool,
    kyriosJesus: text(MAX_SLOT_ITEM_CHARS),
    kyriosGod: text(MAX_SLOT_ITEM_CHARS),
  })
  if (problem) return problem
  return Object.keys(value as Record<string, unknown>).length === 0 ? 'divineNames needs at least one field' : null
}

export function measuresProblem(value: unknown): string | null {
  return oneOf(MEASURES_STRATEGIES)(value, 'measures')
}

export function textualVariantsProblem(value: unknown): string | null {
  return oneOf(TEXTUAL_VARIANT_POLICIES)(value, 'textualVariants')
}

export function headingsProblem(value: unknown): string | null {
  return oneOf(HEADING_POLICIES)(value, 'headings')
}

const quoted = (values: readonly string[]) => values.map((value) => `"${value}"`).join(' | ')

/** Each slot's shape, for describe_command("PatchSettings"). */
export const SLOT_TYPE_NAMES = {
  questionMarkers: '{ suffix?: string[], particles?: string[] }',
  pronouns:
    '{ secondPerson?: { numberDistinction: boolean, singular?: string[], plural?: string[] }, ' +
    'firstPersonPlural?: { clusivity: boolean, inclusive?: string[], exclusive?: string[] }, ' +
    'extraNumbers?: { dual?, trial?, paucal?: boolean, dualForms?, trialForms?, paucalForms?: string[] }, ' +
    'thirdPerson?: { genderOrClass: boolean, forms?: string[] }, ' +
    'honorifics?: { levels: { name: string, forms?: string[] }[] } }',
  negators: 'string[]',
  numberWords: '"cldr" | { [number: string]: string }',
  speechVerbs: 'string[]',
  kinTerms: '{ relativeAgeDistinction: boolean, notes?: string }',
  divineNames: '{ yhwh?: string, deityPronounCapitalization?: boolean, kyriosJesus?: string, kyriosGod?: string }',
  measures: quoted(MEASURES_STRATEGIES),
  textualVariants: quoted(TEXTUAL_VARIANT_POLICIES),
  headings: quoted(HEADING_POLICIES),
} as const
