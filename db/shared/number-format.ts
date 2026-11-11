// Number format per target language (AQU-2430).
//
// AQU-1735 asked for two things the `scripture-reference` check did not ship:
// verse-level reference ranges (still open — it needs a last-verse table per
// versification scheme) and this, the number format half: a translation's
// numbers should be written the way the TARGET language writes numbers, not
// the way the source does.
//
// Three facts per language, and CLDR already knows all three — no new data
// table to keep up:
//
//   * which character groups the thousands ("." in German, "," in English,
//     U+202F in French, "٬" in Egyptian Arabic);
//   * which character marks the decimal fraction ("," in German, "." in
//     English, "٫" in Egyptian Arabic);
//   * which digits the language writes numbers in (Western 0-9, Burmese
//     ၀-၉, Bengali ০-৯, Arabic-Indic ٠-٩ …), and how long a digit group is
//     (three in most languages, two then three in the Indian lakh grouping).
//
// `Intl.NumberFormat(locale).formatToParts()` gives every one of them, which
// is why this file holds no per-language table. What it does hold is the
// discipline around that call:
//
//   1. `Intl` ANSWERS FOR A LANGUAGE IT HAS NEVER HEARD OF. `new
//      Intl.NumberFormat('qqq')` does not throw — it quietly resolves to
//      en-US, so a minority language with no CLDR data would be judged by
//      ENGLISH conventions and every comma in it reported. So a tag is
//      consulted only after `supportedLocalesOf` confirms CLDR has it, and a
//      language it does not have resolves to NO conventions, which leaves the
//      check silent (see `resolveNumberFormat`).
//   2. A freeform label — a lane whose language the catalog does not list, so
//      `laneLanguageForChecks` returns what the user typed — is not a language
//      tag at all, and makes `Intl` throw RangeError rather than return
//      anything. Caught, and treated as "no data"; a label the normalizer
//      knows ("Thai" → tha → th) resolves on the way through, which is the
//      same courtesy `resolvePunctuation` does such a lane.
//
// Western digits are accepted in EVERY language (`WESTERN_DIGITS`): a Burmese
// or Arabic publication writing "40" is writing a number correctly, so only a
// THIRD script's digits are a finding. That floor is what keeps the digit rule
// from firing on most of the world's actual typography.
//
// Pure and dependency-free, with relative imports only and no DOM, so both
// workers can import it alongside ./punctuation-conventions.ts, whose shape
// and resolution order this deliberately mirrors.
//
// Spec: aquilla-specs 04-features/checks-rules-and-living-memory.md ("A check
// that judges the target by the target language says nothing without one") and
// 05-user-stories/run-builtin-check.md's number-format acceptance criteria.

import { normalizeLanguageTag } from './language-normalize'

/** Digits every language is allowed to write a number in. */
export const WESTERN_DIGITS = '0123456789'

/** Most separators one role may list. A role with more is a mistake. */
export const MAX_NUMBER_SEPARATORS = 4

/**
 * What the target language expects of a number.
 *
 * `group` and `decimal` are the characters accepted in each ROLE; a character
 * may be in both (no language does that, but a project override may say so).
 * `groupSizes` are the digit-run lengths a group separator may be followed by
 * — `[3]` for most languages, `[2, 3]` for the Indian lakh grouping.
 * `digits` are the language's own digits, over and above {@link WESTERN_DIGITS}.
 */
export interface NumberFormatConventions {
  group: string[]
  decimal: string[]
  groupSizes: number[]
  digits: string[]
}

/** What a project may store in the Language profile's `numberFormat` slot. */
export type NumberFormatProfile = Partial<Pick<NumberFormatConventions, 'group' | 'decimal'>>

/** Where a resolved set came from, for the Rules page and for tests. */
export type NumberFormatOrigin =
  | { kind: 'profile' }
  | { kind: 'language'; locale: string }
  /** No CLDR data and no filled slot — the check stays silent. */
  | { kind: 'unknown-language' }

export interface ResolvedNumberFormat {
  /** The format to judge the target by, or null to leave the check silent. */
  conventions: NumberFormatConventions | null
  origin: NumberFormatOrigin
}

/** The grouping assumed for a project that answers the slot in a language CLDR has no data for. */
const DEFAULT_GROUP_SIZES: readonly number[] = [3]

/** One language's CLDR answer. */
export interface LanguageNumberFormat {
  locale: string
  conventions: NumberFormatConventions
}

/** Candidate tag → its answer. `Intl.NumberFormat` is far too slow to build per cell. */
const CACHE = new Map<string, LanguageNumberFormat | null>()

/** The CLDR locale for a tag, or null when CLDR has no data for it. */
function supportedLocale(tag: string): string | null {
  try {
    const supported = Intl.NumberFormat.supportedLocalesOf([tag], { localeMatcher: 'lookup' })
    if (supported.length === 0) return null
    return new Intl.NumberFormat(tag).resolvedOptions().locale
  } catch {
    // A freeform label ("Thai", "Spanish") is not a language tag at all.
    return null
  }
}

/** The conventions CLDR gives a locale it has data for. */
function fromCldr(locale: string): NumberFormatConventions {
  const grouped = new Intl.NumberFormat(locale).formatToParts(9876543210)
  const group = grouped.find((part) => part.type === 'group')?.value ?? ''
  // Every integer run but the first sits after a group separator, so their
  // lengths ARE the grouping the language uses.
  const runs = grouped.filter((part) => part.type === 'integer').map((part) => part.value.length)
  const groupSizes = [...new Set(runs.slice(1))].sort((a, b) => a - b)

  const fraction = new Intl.NumberFormat(locale).formatToParts(1.5)
  const decimal = fraction.find((part) => part.type === 'decimal')?.value ?? ''

  // 1234567890 writes all ten digits, in the locale's default numbering system.
  const ungrouped = new Intl.NumberFormat(locale, { useGrouping: false }).format(1234567890)
  const digits = [...new Set(Array.from(ungrouped))].filter((char) => !WESTERN_DIGITS.includes(char))

  return {
    group: group ? [group] : [],
    decimal: decimal ? [decimal] : [],
    groupSizes: groupSizes.length > 0 ? groupSizes : [...DEFAULT_GROUP_SIZES],
    digits,
  }
}

/**
 * The number format of `language`, or null when CLDR has no data for it.
 *
 * `language` may be a code or the label a user typed; it is tried whole, by
 * its primary subtag, and through `normalizeLanguageTag` — the same ladder
 * `punctuationConventionsForLanguage` climbs, so a lane resolves its
 * punctuation and its number format off the same spelling.
 */
export function numberFormatForLanguage(
  language: string | null | undefined,
): LanguageNumberFormat | null {
  const tag = (language ?? '').trim()
  if (!tag) return null
  const parts = tag.split(/[-_]/).filter((part) => part !== '')
  const candidates = [tag, parts[0] ?? '', normalizeLanguageTag(tag.toLowerCase())]
  for (const candidate of candidates) {
    if (!candidate) continue
    let found = CACHE.get(candidate)
    if (found === undefined) {
      const locale = supportedLocale(candidate)
      found = locale ? { locale, conventions: fromCldr(locale) } : null
      CACHE.set(candidate, found)
    }
    if (found) return found
  }
  return null
}

/**
 * CLDR's answer for `language` as the Language profile slot would hold it, for
 * pre-filling the settings row. Null for a language CLDR has no data for.
 */
export function numberFormatProfileForLanguage(
  language: string | null | undefined,
): NumberFormatProfile | null {
  const found = numberFormatForLanguage(language)
  if (!found) return null
  const { group, decimal } = found.conventions
  // A copy: the cache is module state shared by every project on the page.
  return { group: [...group], decimal: [...decimal] }
}

/**
 * Resolve one lane's number format: the Language profile's slot laid over the
 * language's CLDR answer, else that answer alone, else nothing.
 *
 * Unlike `resolvePunctuation`, a filled profile does NOT win whole — it wins
 * per ROLE. The slot records the SEPARATORS a project writes (the one thing a
 * project lead can reasonably disagree with CLDR about); the digits and the
 * grouping stay CLDR's, because the slot cannot say anything about them. A
 * project that answers the slot therefore gets the check even in a language
 * CLDR has never heard of — with Western digits only, which is the floor every
 * language gets.
 */
export function resolveNumberFormat(input: {
  /** The lane's language code, or the label the user typed — either resolves. */
  language?: string | null
  profile?: Readonly<NumberFormatProfile> | null
}): ResolvedNumberFormat {
  const cldr = numberFormatForLanguage(input.language)
  const profile = input.profile
  const answered = profile && (profile.group !== undefined || profile.decimal !== undefined)
  if (answered) {
    return {
      conventions: {
        group: [...(profile.group ?? cldr?.conventions.group ?? [])],
        decimal: [...(profile.decimal ?? cldr?.conventions.decimal ?? [])],
        groupSizes: [...(cldr?.conventions.groupSizes ?? DEFAULT_GROUP_SIZES)],
        digits: [...(cldr?.conventions.digits ?? [])],
      },
      origin: { kind: 'profile' },
    }
  }
  if (cldr) return { conventions: cldr.conventions, origin: { kind: 'language', locale: cldr.locale } }
  return { conventions: null, origin: { kind: 'unknown-language' } }
}
