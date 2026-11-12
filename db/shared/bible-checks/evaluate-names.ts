// Check pack B, names (AQU-1699; design doc §7.2): "if the source cell refers
// to A, the translation names A, and names nobody the source does not have".
//
//   P1  the source names X → the translation has X's agreed name;
//   P3  X shares its Greek name with others (six Marys) → the translation uses
//       X's name, not a namesake's;
//   P4  the source uses one form of X's name (Κηφᾶς, not Σίμων) and the project
//       renders each form its own way → the translation uses that form's;
//   P5  the translation names Y → the source mentions Y in this verse
//       (explicitly, as a pronoun or as a verb's subject), or the verse before
//       or after has Y as a subject;
//   P6  the verse names nobody and its subject is only implied (Λέγει, "he
//       says") → a name the translation puts there is the subject's.
//
// One analysis per evaluation: every agreed name found in the text, with the
// entities it can stand for. A namesake's name is P3's, a wrong subject P6's,
// and only what is left is P5's, so one wrong name is reported once.
//
// Pure, like ./evaluate.ts. Relative imports only, no DOM: shared with the workers.

import type { LanguageProfile } from '../language-profile'
import { acceptedRenderings, entityLabel, firstInScope, formsInScope } from './agreed-names'
import { nameSpans } from './name-match'
import type { CellParticipants, NameMention, ScopedName } from './participant-types'
import { wordNumber, wordRef } from './refs'
import {
  BIBLE_CHECK_DEFAULT_SEVERITY,
  type BibleCheckEvidence,
  type BibleCheckFinding,
  type BibleCheckId,
  type BibleCheckReason,
  type BibleCheckSeverity,
  type BibleCheckSpan,
  type CellExpectation,
} from './types'

export interface PackBCellInput {
  /** The cell's text with notes and markers blanked out: same length, same offsets. */
  text: string
  expectation: CellExpectation
  participants: CellParticipants
  profile: LanguageProfile
}

/** An agreed name in the text, and every entity it is a name of ("John": three men). */
interface NameHit extends BibleCheckSpan {
  entities: string[]
}

export interface NamesAnalysis {
  'bkp:P1': BibleCheckFinding | null
  'bkp:P3': BibleCheckFinding | null
  'bkp:P4': BibleCheckFinding | null
  'bkp:P5': BibleCheckFinding | null
  'bkp:P6': BibleCheckFinding | null
}

const PERSON_TYPES: ReadonlySet<string> = new Set(['person', 'local-person'])

export function packBFinding(
  e: PackBCellInput,
  code: BibleCheckId,
  reason: BibleCheckReason,
  params: Record<string, string>,
  evidence: BibleCheckEvidence,
  options: { severity?: BibleCheckSeverity; spans?: readonly BibleCheckSpan[] } = {},
): BibleCheckFinding {
  return {
    code,
    reason,
    params,
    severity: options.severity ?? BIBLE_CHECK_DEFAULT_SEVERITY[code],
    spans: options.spans ?? [],
    approximate: e.expectation.approximate,
    evidence,
  }
}

/** Every agreed name in the text. A name inside a longer one ("Simon" in "Simon Peter") is the longer one's. */
function findNames(e: PackBCellInput): NameHit[] {
  const { names } = e.participants
  const raw: NameHit[] = []
  for (const entity of names.names.keys()) {
    for (const rendering of acceptedRenderings(names, entity, e.expectation.refs)) {
      for (const span of nameSpans(e.text, rendering)) raw.push({ ...span, entities: [entity] })
    }
  }
  raw.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start))
  const hits: NameHit[] = []
  for (const hit of raw) {
    const same = hits.find((h) => h.start === hit.start && h.end === hit.end)
    if (same) {
      for (const id of hit.entities) if (!same.entities.includes(id)) same.entities.push(id)
    } else if (!hits.some((h) => h.start <= hit.start && hit.end <= h.end)) {
      hits.push({ ...hit, entities: [...hit.entities] })
    }
  }
  return hits
}

/** Where a mention's word is, for the evidence line. */
function mentionEvidence(e: PackBCellInput, entity: string, word: string, mention: string): BibleCheckEvidence {
  return { kind: 'mention', refs: [wordRef(e.expectation.book, word)], entity, word: wordNumber(word), mention }
}

function nameParams(e: PackBCellInput, entity: string, name: ScopedName | null): Record<string, string> {
  const params: Record<string, string> = { name: entityLabel(e.participants.names, entity) }
  if (name) {
    params.rendering = name.renderings[0]
    params.nameSource = name.source
    params.nameFrom = name.from
  }
  return params
}

function uniqueNamed(named: readonly NameMention[]): NameMention[] {
  return named.filter((m, i) => named.findIndex((other) => other.entity === m.entity) === i)
}

/** P1, P3, P4, P5 and P6 for one cell, from one pass over the text. */
export function analyzeNames(e: PackBCellInput): NamesAnalysis {
  const p = e.participants
  const refs = e.expectation.refs
  const hits = findNames(e)
  const mentioned = new Set(p.mentioned)
  const near = new Set([...p.mentioned, ...p.nearbySubjects])
  const claimed = new Set<NameHit>()
  // A namesake the source mentions, and the project has not named, may well be called by the same
  // name: "Mary" where the verse has Mary of Bethany is hers, though "Mary" is agreed for the mother.
  const unnamedNamesakes = new Set(
    [...mentioned].filter((id) => p.names.siblings.has(id) && acceptedRenderings(p.names, id, refs).length === 0),
  )
  const explained = (hit: NameHit, by: ReadonlySet<string>) =>
    hit.entities.some(
      (id) => by.has(id) || (p.names.siblings.get(id) ?? []).some((sibling) => unnamedNamesakes.has(sibling)),
    )
  const isPerson = (hit: NameHit) =>
    hit.entities.some((id) => PERSON_TYPES.has(Object.hasOwn(p.names.entities, id) ? p.names.entities[id].type : ''))
  const has = (entity: string) => hits.some((hit) => hit.entities.includes(entity))
  const text = (hit: NameHit) => e.text.slice(hit.start, hit.end)
  const result: NamesAnalysis = { 'bkp:P1': null, 'bkp:P3': null, 'bkp:P4': null, 'bkp:P5': null, 'bkp:P6': null }

  // P3: a namesake's name where the source names X.
  const confused = new Set<string>()
  for (const m of uniqueNamed(p.named)) {
    if (acceptedRenderings(p.names, m.entity, refs).length === 0 || has(m.entity)) continue
    const siblings = (p.names.siblings.get(m.entity) ?? []).filter((id) => !mentioned.has(id))
    const wrong = hits.filter((hit) => hit.entities.some((id) => siblings.includes(id)))
    if (wrong.length === 0) continue
    confused.add(m.entity)
    for (const hit of wrong) claimed.add(hit)
    const sibling = wrong[0].entities.find((id) => siblings.includes(id)) ?? wrong[0].entities[0]
    result['bkp:P3'] ??= packBFinding(
      e,
      'bkp:P3',
      'homonym-name',
      { ...nameParams(e, m.entity, firstInScope(p.names.names.get(m.entity), refs)), found: text(wrong[0]), other: entityLabel(p.names, sibling) },
      mentionEvidence(e, m.entity, m.word, 'explicit'),
      { spans: wrong },
    )
  }

  // P1: the source names X; the translation has none of X's agreed renderings.
  for (const m of uniqueNamed(p.named)) {
    const accepted = acceptedRenderings(p.names, m.entity, refs)
    if (accepted.length === 0 || has(m.entity) || confused.has(m.entity)) continue
    // A name the context carries (the subject next door, the one speaking or addressed) may become a pronoun.
    const pronounOk = p.nearbySubjects.includes(m.entity) || p.voices.includes(m.entity)
    const params: Record<string, string> = {
      ...nameParams(e, m.entity, firstInScope(p.names.names.get(m.entity), refs)),
      renderings: accepted.join(' | '),
    }
    if (pronounOk) params.pronounOk = 'true'
    result['bkp:P1'] = packBFinding(e, 'bkp:P1', 'name-missing', params, mentionEvidence(e, m.entity, m.word, 'explicit'), {
      severity: pronounOk ? 'info' : undefined,
    })
    break
  }

  // P4: the form the source uses has its own rendering, and the translation lacks it.
  for (const m of p.named) {
    const forms = formsInScope(p.names, m.entity, refs)
    const expected = m.form ? forms.get(m.form) : undefined
    if (forms.size < 2 || !expected || expected.renderings.some((r) => nameSpans(e.text, r).length > 0)) continue
    const found = [...forms.entries()]
      .filter(([form]) => form !== m.form)
      .flatMap(([, name]) => name.renderings)
      .find((r) => nameSpans(e.text, r).length > 0)
    const params = { ...nameParams(e, m.entity, expected), form: m.lemma, ...(found ? { found } : {}) }
    result['bkp:P4'] = packBFinding(e, 'bkp:P4', 'name-form-missing', params, mentionEvidence(e, m.entity, m.word, 'explicit'))
    break
  }

  // P6: the verse names nobody and only implies its subject (Λέγει αὐτῇ, "he says to her"); the
  // translation names someone the source does not mention. Where the verse does name people, a
  // stray name is more likely a wrong name than an inserted subject, and P5 reports it.
  const subjects = p.impliedSubjects.filter((s) => acceptedRenderings(p.names, s.entity, refs).length > 0)
  if (p.named.length === 0 && subjects.length > 0 && !subjects.some((s) => has(s.entity))) {
    const wrong = hits.find((hit) => !claimed.has(hit) && !explained(hit, mentioned))
    if (wrong) {
      claimed.add(wrong)
      const subject = subjects[0]
      const person = isPerson(wrong)
      result['bkp:P6'] = packBFinding(
        e,
        'bkp:P6',
        'subject-name-wrong',
        {
          ...nameParams(e, subject.entity, firstInScope(p.names.names.get(subject.entity), refs)),
          found: text(wrong),
          ...(person ? {} : { person: 'false' }),
        },
        mentionEvidence(e, subject.entity, subject.word, 'subject'),
        // Someone else doing the act is major; a place or a group named there is more likely wording.
        { spans: [wrong], severity: person ? undefined : 'info' },
      )
    }
  }

  // P5: a name the source does not have, in this verse or as the subject next door.
  const stray = hits.find((hit) => !claimed.has(hit) && !explained(hit, near))
  if (stray) {
    const entity = stray.entities[0]
    const person = isPerson(stray)
    result['bkp:P5'] = packBFinding(
      e,
      'bkp:P5',
      'name-not-in-source',
      { name: entityLabel(p.names, entity), found: text(stray), ...(person ? {} : { person: 'false' }) },
      { kind: 'no-mention', refs, entity },
      { spans: [stray], severity: person ? undefined : 'info' },
    )
  }
  return result
}
