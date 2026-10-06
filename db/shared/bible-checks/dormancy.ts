// Why a Bible data check cannot run yet (AQU-1688, AQU-1699).
//
// The quotation and pack-A checks wait for Language-profile SLOTS
// (BIBLE_CHECK_NEEDS). Check pack B waits for more than a filled slot: a
// slot's forms ("you" singular AND plural), a slot that says the language has
// the distinction at all, the project's decisions (`render.*`, `clusivity.*`),
// its terminology, or a word alignment. Each unmet need is a code the Rules
// list renders through t(), so no check is ever dormant silently.
//
// Relative imports only, no DOM: shared with the workers.

import { filledLanguageProfileSlots, type LanguageProfile } from '../language-profile'
import { NO_READINESS, type BibleCheckReadiness } from './participant-types'
import { BIBLE_CHECK_NEEDS, type BibleCheckId, type BibleCheckSlot } from './types'

export type BibleCheckNeed =
  /** An agreed name: a `render.<entity>` decision or a terminology entry. */
  | 'agreedNames'
  /** Two forms of one name with their own decisions: `render.<entity>.form.<form>`. */
  | 'nameForms'
  /** Singular and plural "you" forms in the Language profile. */
  | 'secondPersonForms'
  /** The Language profile says "you" is the same for one person and several. */
  | 'secondPersonSame'
  /** Inclusive and exclusive "we" forms in the Language profile. */
  | 'clusivityForms'
  /** The Language profile says "we" does not change with the listener. */
  | 'clusivitySame'
  /** Dual, trial or paucal forms in the Language profile. */
  | 'groupNumberForms'
  /** The Language profile says the language has no dual, trial or paucal. */
  | 'groupNumberNone'
  /** Renderings of κύριος for Jesus or for God: Divine names, or a `render.kyrios-*` decision. */
  | 'divineNames'
  /** The house style for pronouns that refer to God, in Divine names. */
  | 'deityCapitals'
  /** The house style keeps those pronouns lowercase. */
  | 'deityCapitalsOff'
  /** A word alignment between the Greek and the translation, to find each pronoun. */
  | 'alignment'
  /** A `clusivity.*` decision for some passage. */
  | 'clusivityDecisions'

export type BibleCheckDormancy = { slot: BibleCheckSlot } | { need: BibleCheckNeed }

type NeedsOf = (profile: LanguageProfile, readiness: BibleCheckReadiness) => BibleCheckNeed[]

function secondPersonNeed(profile: LanguageProfile): BibleCheckNeed[] {
  const second = profile.pronouns?.secondPerson
  if (second && !second.numberDistinction) return ['secondPersonSame']
  return second?.singular?.length && second.plural?.length ? [] : ['secondPersonForms']
}

function clusivityNeed(profile: LanguageProfile): BibleCheckNeed[] {
  const first = profile.pronouns?.firstPersonPlural
  if (first && !first.clusivity) return ['clusivitySame']
  return first?.inclusive?.length && first.exclusive?.length ? [] : ['clusivityForms']
}

function groupNumberNeed(profile: LanguageProfile): BibleCheckNeed[] {
  const extra = profile.pronouns?.extraNumbers
  if (
    (extra?.dual && extra.dualForms?.length) ||
    (extra?.trial && extra.trialForms?.length) ||
    (extra?.paucal && extra.paucalForms?.length)
  ) {
    return []
  }
  return extra?.dual === false && extra.trial === false && extra.paucal === false ? ['groupNumberNone'] : ['groupNumberForms']
}

const names: NeedsOf = (_profile, readiness) => (readiness.agreedNames ? [] : ['agreedNames'])

const PACK_B_NEEDS: Partial<Record<BibleCheckId, NeedsOf>> = {
  'bkp:P1': names,
  'bkp:P2': names,
  'bkp:P3': names,
  'bkp:P4': (_profile, readiness) => (readiness.nameForms ? [] : ['nameForms']),
  'bkp:P5': names,
  'bkp:P6': names,
  'bkp:P8': secondPersonNeed,
  'bkp:P9': clusivityNeed,
  'bkp:P10': groupNumberNeed,
  'bkp:P14': (profile, readiness) =>
    readiness.divineNameFacts || profile.divineNames?.kyriosJesus || profile.divineNames?.kyriosGod ? [] : ['divineNames'],
  'bkp:P15': (profile, readiness) => {
    const capitals = profile.divineNames?.deityPronounCapitalization
    const needs: BibleCheckNeed[] = capitals === true ? [] : capitals === false ? ['deityCapitalsOff'] : ['deityCapitals']
    return readiness.pronounSpans ? needs : [...needs, 'alignment']
  },
  'bkp:X4': (profile, readiness) => [
    ...(readiness.clusivityFacts ? [] : (['clusivityDecisions'] as const)),
    ...clusivityNeed(profile),
  ],
}

/** Everything a check still waits for; empty when it can run. */
export function bibleCheckDormancy(
  id: BibleCheckId,
  profile: LanguageProfile | null | undefined,
  readiness: BibleCheckReadiness = NO_READINESS,
): BibleCheckDormancy[] {
  const filled = filledLanguageProfileSlots(profile)
  const slots = BIBLE_CHECK_NEEDS[id].filter((slot) => !filled.has(slot)).map((slot) => ({ slot }))
  const needs = (PACK_B_NEEDS[id]?.(profile ?? {}, readiness) ?? []).map((need) => ({ need }))
  return [...slots, ...needs]
}

/**
 * True when a check cannot run. Without `readiness` a check that needs the
 * project's decisions or terminology counts as dormant.
 */
export function isBibleCheckDormant(
  id: BibleCheckId,
  profile: LanguageProfile | null | undefined,
  readiness?: BibleCheckReadiness,
): boolean {
  return bibleCheckDormancy(id, profile, readiness).length > 0
}

/**
 * AQU-1697: checks that read the text layer. N1 and N2 need it; M3 and S3 are
 * sharper with it. AQU-1699: so do the pack-B checks that read which words are
 * names, persons and numbers.
 */
const TEXT_LAYER_CHECKS: readonly BibleCheckId[] = [
  'bkp:N1', 'bkp:N2', 'bkp:M3', 'bkp:S3',
  'bkp:P1', 'bkp:P3', 'bkp:P4', 'bkp:P8', 'bkp:P9', 'bkp:P10', 'bkp:P14', 'bkp:X4',
]

/** AQU-1699: checks that read the people layer (who each word refers to). */
const PEOPLE_LAYER_CHECKS: readonly BibleCheckId[] = [
  'bkp:P1', 'bkp:P3', 'bkp:P4', 'bkp:P5', 'bkp:P6', 'bkp:P9', 'bkp:P10', 'bkp:P14', 'bkp:P15', 'bkp:X4',
]

/** Is the text layer worth loading for this profile? Several MB per book, so only when a check reads it. */
export function bibleChecksReadText(
  profile: LanguageProfile | null | undefined,
  readiness: BibleCheckReadiness = NO_READINESS,
): boolean {
  return TEXT_LAYER_CHECKS.some((id) => !isBibleCheckDormant(id, profile, readiness))
}

/** AQU-1699: is the people layer worth loading? Only while a check-pack-B check that reads it can run. */
export function bibleChecksReadPeople(
  profile: LanguageProfile | null | undefined,
  readiness: BibleCheckReadiness = NO_READINESS,
): boolean {
  return PEOPLE_LAYER_CHECKS.some((id) => !isBibleCheckDormant(id, profile, readiness))
}
