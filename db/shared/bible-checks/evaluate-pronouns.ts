// Check pack B, pronouns and divine names (AQU-1699; design doc §7.2, §7.7):
//
//   P8   the Greek "you" in the verse is all singular or all plural → the
//        translation has a form of that number and none of the other;
//   P9   "we" includes the people addressed, or leaves them out → inclusive or
//        exclusive "we" (decided from data in ./compile-participants.ts);
//   X4   a recorded `clusivity.*` decision covers the verse → its form, over
//        anything P9 would infer;
//   P10  a pronoun refers to a group of two, three or a few → dual, trial or
//        paucal, when the language has them;
//   P14  κύριος of Jesus, κύριος of God, πνεῦμα of the Holy Spirit → the
//        project's rendering of each;
//   P15  a pronoun for God, Jesus or the Spirit starts with a capital, where
//        the house style says so. It needs each pronoun's place in the
//        translation, from a word alignment; no project has one yet, so it is
//        dormant everywhere (./dormancy.ts).
//
// The forms come from the Language profile; a form listed for both numbers
// (or both clusivities) says nothing, so it is left out. Pure; relative
// imports only, no DOM: shared with the workers.

import type { PronounsProfile } from '../language-profile'
import { clusivityDecisionFor, entityLabel, firstInScope } from './agreed-names'
import { MAX_PAUCAL } from './compile-participants'
import { packBFinding, type PackBCellInput } from './evaluate-names'
import { formSpans, nameSpans } from './name-match'
import type { Clusivity, DivineNameKind, FirstPluralMention } from './participant-types'
import { wordNumber, wordRef } from './refs'
import type { BibleCheckEvidence, BibleCheckFinding, BibleCheckSpan } from './types'

/** Forms of one side that the other side does not also list. */
function only(forms: readonly string[] | undefined, other: readonly string[] | undefined): string[] {
  return (forms ?? []).filter((form) => !(other ?? []).includes(form))
}

// ── P8: "you" singular or plural ────────────────────────────────────────────

export function checkSecondPerson(e: PackBCellInput): BibleCheckFinding | null {
  const second = e.participants.secondPerson
  const forms = e.profile.pronouns?.secondPerson
  if (!second || second.number === 'mixed' || !forms?.numberDistinction) return null
  const singular = second.number === 'singular'
  const want = only(singular ? forms.singular : forms.plural, singular ? forms.plural : forms.singular)
  const other = only(singular ? forms.plural : forms.singular, singular ? forms.singular : forms.plural)
  const evidence: BibleCheckEvidence = { kind: 'second-person', refs: e.expectation.refs, number: second.number }
  const params = { number: second.number }
  const wrong = formSpans(e.text, other)
  if (wrong.length > 0) return packBFinding(e, 'bkp:P8', 'you-number-wrong', params, evidence, { spans: wrong })
  // An imperative alone may stand without a pronoun; a pronoun or a finite verb needs one.
  if (second.explicit && formSpans(e.text, want).length === 0) {
    return packBFinding(e, 'bkp:P8', 'you-number-missing', params, evidence)
  }
  return null
}

// ── P9, X4: inclusive or exclusive "we" ─────────────────────────────────────

function clusivityFinding(
  e: PackBCellInput,
  code: 'bkp:P9' | 'bkp:X4',
  want: Clusivity,
  evidence: BibleCheckEvidence,
  extra: Record<string, string> = {},
): BibleCheckFinding | null {
  const forms = e.profile.pronouns?.firstPersonPlural
  if (!forms?.clusivity) return null
  const inclusive = only(forms.inclusive, forms.exclusive)
  const exclusive = only(forms.exclusive, forms.inclusive)
  const params = { clusivity: want, ...extra }
  const wrong = formSpans(e.text, want === 'inclusive' ? exclusive : inclusive)
  if (wrong.length > 0) return packBFinding(e, code, 'clusivity-wrong', params, evidence, { spans: wrong })
  if (formSpans(e.text, want === 'inclusive' ? inclusive : exclusive).length === 0) {
    return packBFinding(e, code, 'clusivity-missing', params, evidence)
  }
  return null
}

/** Who "we" are and who is addressed, as the pack's labels; a group with listed members is its members. */
function clusivityEvidence(e: PackBCellInput, mention: FirstPluralMention): BibleCheckEvidence {
  const { names } = e.participants
  const labels = (ids: readonly string[]) =>
    ids
      .filter((id) => !(Object.hasOwn(names.entities, id) && names.entities[id].members?.length))
      .map((id) => entityLabel(names, id))
  return {
    kind: 'clusivity',
    refs: [wordRef(e.expectation.book, mention.word)],
    word: wordNumber(mention.word),
    referents: labels(mention.referents),
    addressees: labels(mention.addressees),
  }
}

export function checkClusivity(e: PackBCellInput): BibleCheckFinding | null {
  // A recorded decision settles the verse: X4 enforces it, and P9's inference stands down.
  if (clusivityDecisionFor(e.participants.names, e.expectation.refs)) return null
  const decided = e.participants.firstPlural.filter((m) => m.clusivity !== null)
  const values = new Set(decided.map((m) => m.clusivity))
  // Both kinds of "we" in one verse: which form goes where needs an alignment.
  if (decided.length === 0 || values.size > 1) return null
  const want = decided[0].clusivity
  return want ? clusivityFinding(e, 'bkp:P9', want, clusivityEvidence(e, decided[0])) : null
}

export function checkClusivityDecision(e: PackBCellInput): BibleCheckFinding | null {
  const decision = clusivityDecisionFor(e.participants.names, e.expectation.refs)
  if (!decision || e.participants.firstPlural.length === 0) return null
  const want: Clusivity = decision.value.trim().toLowerCase() === 'inclusive' ? 'inclusive' : 'exclusive'
  return clusivityFinding(e, 'bkp:X4', want, { kind: 'decision', refs: e.expectation.refs, key: decision.key }, { decision: decision.key })
}

// ── P10: dual, trial, paucal ────────────────────────────────────────────────

type GroupNumber = 'dual' | 'trial' | 'paucal'

function groupNumber(size: number, extra: NonNullable<PronounsProfile['extraNumbers']>): { number: GroupNumber; forms: string[] } | null {
  if (size === 2 && extra.dual && extra.dualForms?.length) return { number: 'dual', forms: extra.dualForms }
  if (size === 3 && extra.trial && extra.trialForms?.length) return { number: 'trial', forms: extra.trialForms }
  if (size >= 3 && size <= MAX_PAUCAL && extra.paucal && extra.paucalForms?.length) return { number: 'paucal', forms: extra.paucalForms }
  return null
}

export function checkGroupNumber(e: PackBCellInput): BibleCheckFinding | null {
  const extra = e.profile.pronouns?.extraNumbers
  if (!extra) return null
  for (const group of e.participants.groups) {
    const expected = groupNumber(group.size, extra)
    if (!expected || formSpans(e.text, expected.forms).length > 0) continue
    return packBFinding(
      e,
      'bkp:P10',
      'group-number-missing',
      { number: expected.number, size: String(group.size), name: entityLabel(e.participants.names, group.entity) },
      { kind: 'group', refs: [wordRef(e.expectation.book, group.word)], entity: group.entity, size: group.size, word: wordNumber(group.word) },
    )
  }
  return null
}

// ── P14: κύριος and πνεῦμα ──────────────────────────────────────────────────

/** The project's renderings of a divine name here: a decision in scope, else the Divine names slot. */
function divineRenderings(e: PackBCellInput, kind: DivineNameKind): readonly string[] {
  const decision = e.participants.names.divine.get(kind)
  const decided = decision ? firstInScope([decision], e.expectation.refs) : null
  if (decided) return decided.renderings
  const slot = e.profile.divineNames
  const value = kind === 'kyrios-jesus' ? slot?.kyriosJesus : kind === 'kyrios-god' ? slot?.kyriosGod : undefined
  return value ? [value] : []
}

/**
 * Where a divine name's rendering stands. Case counts ("LORD" is not "Lord":
 * small capitals are the convention), except for the first letter, which a
 * sentence may capitalize.
 */
function divineSpans(text: string, rendering: string): BibleCheckSpan[] {
  const first = Array.from(rendering)[0] ?? ''
  const rest = rendering.slice(first.length)
  const spans = [...new Set([rendering, first.toUpperCase() + rest, first.toLowerCase() + rest])].flatMap((r) => nameSpans(text, r, true))
  return spans.filter((span, i) => spans.findIndex((s) => s.start === span.start && s.end === span.end) === i)
}

export function checkDivineNames(e: PackBCellInput): BibleCheckFinding | null {
  const kinds = [...new Set(e.participants.divine.map((d) => d.kind))]
  for (const kind of kinds) {
    const expected = divineRenderings(e, kind)
    if (expected.length === 0) continue
    const otherKind: DivineNameKind | null = kind === 'kyrios-jesus' ? 'kyrios-god' : kind === 'kyrios-god' ? 'kyrios-jesus' : null
    const other = otherKind && !kinds.includes(otherKind) ? divineRenderings(e, otherKind).filter((r) => !expected.includes(r)) : []
    if (expected.some((r) => divineSpans(e.text, r).length > 0)) continue
    const mention = e.participants.divine.find((d) => d.kind === kind)
    const evidence: BibleCheckEvidence = {
      kind: 'divine-name',
      refs: mention ? [wordRef(e.expectation.book, mention.word)] : e.expectation.refs,
      word: mention ? wordNumber(mention.word) : 0,
    }
    const params = { divine: kind, rendering: expected[0] }
    const swapped = other.flatMap((r) => divineSpans(e.text, r))
    return swapped.length > 0
      ? packBFinding(e, 'bkp:P14', 'divine-name-swapped', { ...params, found: e.text.slice(swapped[0].start, swapped[0].end) }, evidence, {
          spans: swapped,
        })
      : packBFinding(e, 'bkp:P14', 'divine-name-missing', params, evidence)
  }
  return null
}

// ── P15: capitals for pronouns that refer to God ────────────────────────────

const HAS_CASE = (ch: string) => ch.toLowerCase() !== ch.toUpperCase()

export function checkDeityPronouns(e: PackBCellInput): BibleCheckFinding | null {
  if (e.profile.divineNames?.deityPronounCapitalization !== true) return null
  const lower = (e.participants.deityPronounSpans ?? []).filter((span) => {
    const first = Array.from(e.text.slice(span.start, span.end))[0] ?? ''
    return HAS_CASE(first) && first === first.toLowerCase()
  })
  if (lower.length === 0) return null
  return packBFinding(e, 'bkp:P15', 'deity-pronoun-lowercase', {}, { kind: 'alignment', refs: e.expectation.refs }, { spans: lower })
}
