// Language profile (AQU-1688): the facts about a project's target language that
// Bible data checks need. Stored as the `languageProfile` project setting.
//
// Each fact is one optional SLOT. A check that needs an empty slot stays
// dormant: it produces no findings, and its row in Rules → Built-in checks says
// which slot it needs. AQU-1691 added the slots in ./language-profile-slots.ts
// (question markers, pronouns, negators, number words, speech verbs, kin terms,
// divine names, and the measures, textual-variant and heading policies). Add a
// slot to `LanguageProfile` and `SLOT_PROBLEMS`; the reader, the filled-slot
// set and the describe_command type follow from those two.
//
// Each slot validates on its own: the reader keeps every valid slot and drops
// an invalid one, so one damaged slot never silences another slot's checks.
// A writer merges over the STORED object, so a slot this version does not know
// survives a save.
//
// Pure and dependency-free, with relative imports only and no DOM, so both
// workers can import it: the settings-key registry validates agent writes with
// `languageProfileProblem`, and autopilot reads the stored value with
// `readLanguageProfile` (AQU-1691: auth-worker/src/lib/contextual/project-context.ts).
//
// Spec: aquilla-specs 04-features/bible-knowledge-layer.md (Language profile)
// and the bible-wiki design doc §4.7.

import {
  SLOT_TYPE_NAMES,
  divineNamesProblem,
  headingsProblem,
  isPlainObject,
  kinTermsProblem,
  measuresProblem,
  negatorsProblem,
  numberWordsProblem,
  pronounsProblem,
  questionMarkersProblem,
  speechVerbsProblem,
  textualVariantsProblem,
  type DivineNamesProfile,
  type HeadingPolicy,
  type KinTermsProfile,
  type MeasuresStrategy,
  type NumberWordsProfile,
  type PronounsProfile,
  type QuestionMarkersProfile,
  type TextualVariantPolicy,
} from './language-profile-slots'

export type {
  DivineNamesProfile,
  HeadingPolicy,
  KinTermsProfile,
  MeasuresStrategy,
  NumberWordsProfile,
  PronounsProfile,
  QuestionMarkersProfile,
  TextualVariantPolicy,
} from './language-profile-slots'
export { HEADING_POLICIES, MEASURES_STRATEGIES, TEXTUAL_VARIANT_POLICIES } from './language-profile-slots'

/**
 * How a quotation that runs over several paragraphs marks each new paragraph:
 *   reopen-each-paragraph — the paragraph starts with the level's OPENING mark,
 *                           and the previous paragraph is not closed (English);
 *   continuation-mark     — the paragraph starts with the level's CLOSING mark
 *                           (Spanish « … ¶ » … »);
 *   none                  — nothing marks it.
 */
export const QUOTE_CONTINUATION_STYLES = ['reopen-each-paragraph', 'continuation-mark', 'none'] as const
export type QuoteContinuationStyle = (typeof QUOTE_CONTINUATION_STYLES)[number]

/** One nesting level's marks. Each is a single character, e.g. “ and ”. */
export interface QuoteMarkPair {
  open: string
  close: string
}

/** The most levels a profile records. Deeper quotations alternate levels 2 and 3. */
export const MAX_QUOTE_LEVELS = 3

export interface QuoteMarksProfile {
  /** Level 1 first; levels 2 and 3 are optional. */
  levels: QuoteMarkPair[]
  continuation: QuoteContinuationStyle
}

export interface LanguageProfile {
  quoteMarks?: QuoteMarksProfile
  questionMarkers?: QuestionMarkersProfile
  pronouns?: PronounsProfile
  negators?: string[]
  numberWords?: NumberWordsProfile
  speechVerbs?: string[]
  kinTerms?: KinTermsProfile
  divineNames?: DivineNamesProfile
  measures?: MeasuresStrategy
  textualVariants?: TextualVariantPolicy
  headings?: HeadingPolicy
}

export type LanguageProfileSlot = keyof LanguageProfile

/**
 * A quote mark is exactly one character that is not a letter, a digit or
 * whitespace. The checks count marks character by character, so a longer
 * string could never match.
 */
export function isQuoteMarkCharacter(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const chars = Array.from(value)
  if (chars.length !== 1) return false
  return !/[\p{L}\p{N}\s]/u.test(value)
}

function quoteMarksProblem(value: unknown): string | null {
  if (!isPlainObject(value)) return 'quoteMarks must be an object'
  for (const key of Object.keys(value)) {
    if (key !== 'levels' && key !== 'continuation') return `quoteMarks has an unknown field "${key}"`
  }
  const { levels, continuation } = value
  if (!Array.isArray(levels) || levels.length < 1 || levels.length > MAX_QUOTE_LEVELS) {
    return `quoteMarks.levels must list 1 to ${MAX_QUOTE_LEVELS} levels`
  }
  for (const [index, level] of levels.entries()) {
    if (!isPlainObject(level)) return `quoteMarks.levels[${index}] must be an object`
    for (const key of Object.keys(level)) {
      if (key !== 'open' && key !== 'close') return `quoteMarks.levels[${index}] has an unknown field "${key}"`
    }
    if (!isQuoteMarkCharacter(level.open) || !isQuoteMarkCharacter(level.close)) {
      return `quoteMarks.levels[${index}] needs one punctuation character for "open" and for "close"`
    }
  }
  if (!(QUOTE_CONTINUATION_STYLES as readonly unknown[]).includes(continuation)) {
    return `quoteMarks.continuation must be one of ${QUOTE_CONTINUATION_STYLES.join(', ')}`
  }
  return null
}

const SLOT_PROBLEMS: Readonly<Record<LanguageProfileSlot, (value: unknown) => string | null>> = {
  quoteMarks: quoteMarksProblem,
  questionMarkers: questionMarkersProblem,
  pronouns: pronounsProblem,
  negators: negatorsProblem,
  numberWords: numberWordsProblem,
  speechVerbs: speechVerbsProblem,
  kinTerms: kinTermsProblem,
  divineNames: divineNamesProblem,
  measures: measuresProblem,
  textualVariants: textualVariantsProblem,
  headings: headingsProblem,
}

/** Every slot, in the order the settings card and describe_command list them. */
export const LANGUAGE_PROFILE_SLOTS = Object.keys(SLOT_PROBLEMS) as readonly LanguageProfileSlot[]

export function isLanguageProfileSlot(key: string): key is LanguageProfileSlot {
  return Object.prototype.hasOwnProperty.call(SLOT_PROBLEMS, key)
}

/** Null when `value` is a valid value for `slot`, else what is wrong with it. */
export function languageProfileSlotProblem(slot: LanguageProfileSlot, value: unknown): string | null {
  return SLOT_PROBLEMS[slot](value)
}

const QUOTE_MARKS_TYPE_NAME =
  '{ levels: { open: string, close: string }[] (1–3 levels, one character each), ' +
  `continuation: ${QUOTE_CONTINUATION_STYLES.map((s) => `"${s}"`).join(' | ')} }`

/** Shown by describe_command("PatchSettings") and in validation errors. */
export const LANGUAGE_PROFILE_TYPE_NAME = `{ ${LANGUAGE_PROFILE_SLOTS.map(
  (slot) => `${slot}?: ${slot === 'quoteMarks' ? QUOTE_MARKS_TYPE_NAME : SLOT_TYPE_NAMES[slot]}`,
).join(', ')} }`

/** Null when `value` is a valid profile, else what is wrong with it. Unknown slots are rejected. */
export function languageProfileProblem(value: unknown): string | null {
  if (!isPlainObject(value)) return 'languageProfile must be an object'
  for (const [key, slot] of Object.entries(value)) {
    if (!isLanguageProfileSlot(key)) return `languageProfile has an unknown slot "${key}"`
    // An explicit undefined is the same as a missing slot.
    if (slot === undefined) continue
    const problem = SLOT_PROBLEMS[key](slot)
    if (problem) return problem
  }
  return null
}

/**
 * Read a stored `languageProfile` that may arrive as a JSON string (a TEXT
 * column) or as parsed JSON. Keeps each valid slot and drops an invalid one,
 * so a damaged slot leaves its checks dormant instead of noisy. Unknown slots
 * are left out: this is the reader, not a writer.
 */
export function readLanguageProfile(raw: unknown): LanguageProfile {
  let value = raw
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw)
    } catch {
      return {}
    }
  }
  if (!isPlainObject(value)) return {}
  const out: Record<string, unknown> = {}
  for (const slot of LANGUAGE_PROFILE_SLOTS) {
    const slotValue = value[slot]
    if (slotValue === undefined || SLOT_PROBLEMS[slot](slotValue) !== null) continue
    // A validated slot is plain JSON, so a round trip copies it without aliasing the stored object.
    out[slot] = JSON.parse(JSON.stringify(slotValue))
  }
  return out as LanguageProfile
}

/** The slots that are filled in. A check is dormant while any slot it needs is missing. */
export function filledLanguageProfileSlots(profile: LanguageProfile | null | undefined): Set<LanguageProfileSlot> {
  const filled = new Set<LanguageProfileSlot>()
  for (const slot of LANGUAGE_PROFILE_SLOTS) {
    if (profile?.[slot] !== undefined) filled.add(slot)
  }
  return filled
}
