// Language profile (AQU-1688): the facts about a project's target language that
// Bible data checks need. Stored as the `languageProfile` project setting.
//
// Each fact is one optional SLOT. A check that needs an empty slot stays
// dormant: it produces no findings, and its row in Rules → Built-in checks says
// which slot it needs. AQU-1691 adds more slots (pronoun distinctions, question
// markers, negators, number words, kin terms, divine-name policy); add each one
// to `LANGUAGE_PROFILE_SLOTS`, `SLOT_PROBLEMS` and `readLanguageProfile`.
//
// Pure and dependency-free, with relative imports only and no DOM, so both
// workers can import it: the settings-key registry validates agent writes with
// `languageProfileProblem`, and autopilot (AQU-1690) reads the stored value with
// `readLanguageProfile`.
//
// Spec: aquilla-specs 04-features/bible-knowledge-layer.md (Language profile)
// and the bible-wiki design doc §4.7.

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
}

export const LANGUAGE_PROFILE_SLOTS = ['quoteMarks'] as const
export type LanguageProfileSlot = (typeof LANGUAGE_PROFILE_SLOTS)[number]

/** Shown by describe_command("PatchSettings") and in validation errors. */
export const LANGUAGE_PROFILE_TYPE_NAME =
  '{ quoteMarks?: { levels: { open: string, close: string }[] (1–3 levels, one character each), ' +
  `continuation: ${QUOTE_CONTINUATION_STYLES.map((s) => `"${s}"`).join(' | ')} } }`

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

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
}

function isSlot(key: string): key is LanguageProfileSlot {
  return (LANGUAGE_PROFILE_SLOTS as readonly string[]).includes(key)
}

/** Null when `value` is a valid profile, else what is wrong with it. Unknown slots are rejected. */
export function languageProfileProblem(value: unknown): string | null {
  if (!isPlainObject(value)) return 'languageProfile must be an object'
  for (const [key, slot] of Object.entries(value)) {
    if (!isSlot(key)) return `languageProfile has an unknown slot "${key}"`
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
 * so a damaged slot leaves its checks dormant instead of noisy.
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
  const out: LanguageProfile = {}
  if (value.quoteMarks !== undefined && quoteMarksProblem(value.quoteMarks) === null) {
    const quoteMarks = value.quoteMarks as unknown as QuoteMarksProfile
    out.quoteMarks = {
      levels: quoteMarks.levels.map(({ open, close }) => ({ open, close })),
      continuation: quoteMarks.continuation,
    }
  }
  return out
}

/** The slots that are filled in. A check is dormant while any slot it needs is missing. */
export function filledLanguageProfileSlots(profile: LanguageProfile | null | undefined): Set<LanguageProfileSlot> {
  const filled = new Set<LanguageProfileSlot>()
  if (profile?.quoteMarks) filled.add('quoteMarks')
  return filled
}
