// Per-cell Bible facts for autopilot prompts (AQU-1690).
//
// What the pack says about one cell, as given facts a model need not guess:
// who speaks to whom and where each quotation opens and closes, who the cell
// names, which subjects its verbs imply, whether "you" is singular or plural
// in the Greek, and whether the Greek asks a question, negates, or counts.
//
// Pure: built from the cell's compiled expectation (../bible-checks/compile.ts,
// so facts and checks agree on every speech) and the pack layers. Nothing here
// reads any cell's text. Kept short and clipped: the line rides every draft
// prompt.
//
// Relative imports only, no DOM: shared with the workers.

import type { CellExpectation } from '../bible-checks/types'
import type {
  CellFacts,
  FactEntity,
  FactsLayers,
  FactsMentionInput,
  FactsPeopleInput,
  FactsSpeechInput,
  FactsTextInput,
  FactsVoicesInput,
  FactsWordInput,
  SecondPersonNumber,
  SpeechFact,
} from './types'

const MAX_SPEECHES = 3
const MAX_NAMED = 5
const MAX_IMPLIED = 3
/** Ceiling on one rendered line. */
export const MAX_FACTS_LINE_CHARS = 360

/**
 * Who can be a participant. A place says where, not who. Deities are left out
 * of the named list: the pack labels θεός with its "LORD" entity, and a line
 * that names "LORD" would push the drafter toward the divine-name rendering.
 * A deity that SPEAKS still appears as the speaker.
 */
const PARTICIPANT_TYPES: ReadonlySet<string> = new Set(['person', 'group', 'local-person', 'local-group'])

function own<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined
}

// ── Indexes, built once per layer object ────────────────────────────────────

const speechIndexes = new WeakMap<FactsVoicesInput, Map<string, FactsSpeechInput>>()

function speechById(voices: FactsVoicesInput): Map<string, FactsSpeechInput> {
  let index = speechIndexes.get(voices)
  if (!index) {
    index = new Map(voices.speeches.map((speech) => [speech.id, speech]))
    speechIndexes.set(voices, index)
  }
  return index
}

/** Mentions per verse, keyed by the verse part of the word id ("n" + book + chapter + verse). */
const mentionIndexes = new WeakMap<FactsPeopleInput, Map<string, [string, FactsMentionInput][]>>()

function mentionsByVerse(people: FactsPeopleInput): Map<string, [string, FactsMentionInput][]> {
  let index = mentionIndexes.get(people)
  if (!index) {
    index = new Map()
    for (const [wordId, mention] of Object.entries(people.mentions)) {
      const key = wordId.slice(0, 9)
      const list = index.get(key) ?? []
      list.push([wordId, mention])
      index.set(key, list)
    }
    for (const list of index.values()) list.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    mentionIndexes.set(people, index)
  }
  return index
}

/** The verse part of the word ids in `ref`, read off the voices layer (every compiled ref has runs there). */
function verseKey(voices: FactsVoicesInput, ref: string): string | null {
  const first = own(voices.verses, ref)?.[0]?.from
  return first ? first.slice(0, 9) : null
}

// ── Facts ───────────────────────────────────────────────────────────────────

function entityFact(id: string, people: FactsPeopleInput | null, renderings?: ReadonlyMap<string, string>): FactEntity {
  const labels = people ? own(people.entities, id)?.labels : undefined
  const label = (labels && (own(labels, 'eng') ?? Object.values(labels)[0])) || id
  const rendering = renderings?.get(id)
  return { id, label, ...(rendering ? { rendering } : {}) }
}

function isParticipant(people: FactsPeopleInput, id: string): boolean {
  const entity = own(people.entities, id)
  if (!entity || !PARTICIPANT_TYPES.has(entity.type)) return false
  // The pack mints some things as local persons ("water", JHN 4:10). A
  // neuter "person" is one of those.
  return !(entity.type === 'local-person' && entity.gender === 'neuter')
}

/**
 * A second-person verb, or a second-person personal pronoun (σύ, ὑμεῖς).
 * Possessives are left out: their number is the possessed noun's. Exported
 * for the worker's pack loader, which keeps only these words of a text layer.
 */
export function isSecondPersonWord(word: FactsWordInput): boolean {
  return word.person === 'second' || (word.class === 'pron' && /^P-2/.test(word.morph))
}

function secondPersonOf(text: FactsTextInput | null, refs: readonly string[]): SecondPersonNumber | null {
  if (!text) return null
  const numbers = new Set<string>()
  for (const ref of refs) {
    for (const wordId of own(text.verses, ref) ?? []) {
      const word = own(text.words, wordId)
      if (!word) continue
      if (isSecondPersonWord(word) && (word.number === 'singular' || word.number === 'plural')) numbers.add(word.number)
    }
  }
  if (numbers.size === 0) return null
  if (numbers.size > 1) return 'mixed'
  return numbers.has('singular') ? 'singular' : 'plural'
}

/**
 * The facts for one cell, from its compiled expectation and the pack layers.
 * `renderings` maps an entity id to the project's agreed rendering of the
 * name, when the caller found one.
 */
export function computeCellFacts(
  expectation: CellExpectation,
  layers: FactsLayers,
  renderings?: ReadonlyMap<string, string>,
): CellFacts {
  const { voices, structure, people, text } = layers
  const speeches = speechById(voices)
  const speechFacts: SpeechFact[] = expectation.speeches.map((s) => {
    const speech = speeches.get(s.id)
    return {
      speechId: s.id,
      speaker: speech?.speaker ? entityFact(speech.speaker, people, renderings) : null,
      addressee: speech?.addressee ? entityFact(speech.addressee, people, renderings) : null,
      level: s.level,
      depth: s.depth,
      selfProjected: s.selfProjected,
      opens: s.opens,
      closes: s.closes,
      continues: s.continues,
    }
  })

  const named = new Map<string, FactEntity>()
  const implied = new Map<string, FactEntity>()
  if (people) {
    const index = mentionsByVerse(people)
    for (const ref of expectation.refs) {
      const key = verseKey(voices, ref)
      for (const [, mention] of (key && index.get(key)) || []) {
        if (!isParticipant(people, mention.entity)) continue
        const target = mention.kind === 'explicit' ? named : mention.kind === 'subject' ? implied : null
        if (target && !target.has(mention.entity)) target.set(mention.entity, entityFact(mention.entity, people, renderings))
      }
    }
  }

  let negators = 0
  let numerals = 0
  for (const ref of expectation.refs) {
    const verse = structure ? own(structure.verses, ref) : undefined
    negators += verse?.negators?.length ?? 0
    numerals += verse?.numerals?.length ?? 0
  }

  return {
    book: expectation.book,
    refs: expectation.refs,
    speeches: speechFacts,
    participants: [...named.values()],
    impliedSubjects: [...implied.values()].filter((entity) => !named.has(entity.id)),
    secondPerson: secondPersonOf(text, expectation.refs),
    question: expectation.question.expected,
    negators,
    numerals,
    trailingText: expectation.trailingNarration
      ? { closeLevel: expectation.trailingNarration.closeLevel, endLevel: expectation.trailingNarration.endLevel }
      : null,
  }
}

// ── Rendering ───────────────────────────────────────────────────────────────

function nameOf(entity: FactEntity | null, withId: boolean): string {
  if (!entity) return 'unknown'
  const name = entity.rendering ? `${entity.label} ("${entity.rendering}")` : entity.label
  return withId ? `${name} [${entity.id}]` : name
}

function speechShape(speech: SpeechFact): string {
  const where = speech.opens && speech.closes
    ? 'opens and closes here'
    : speech.opens
      ? 'opens here and continues after this cell'
      : speech.closes
        ? 'began before this cell and closes here'
        : 'began before this cell and continues after it'
  return speech.level >= 1 && !speech.selfProjected ? `quote level ${speech.level} ${where}` : `unquoted speech ${where}`
}

function names(entities: readonly FactEntity[], max: number): string {
  return entities.slice(0, max).map((entity) => nameOf(entity, false)).join(', ')
}

function clipLine(line: string): string {
  return line.length > MAX_FACTS_LINE_CHARS ? `${line.slice(0, MAX_FACTS_LINE_CHARS - 1)}…` : line
}

/**
 * One line of facts for a cell. "draft" is the full line for the drafter and
 * the verifiers (speaker → addressee with entity ids, quote levels, named
 * participants, implied subjects, "you", question, negation, numerals);
 * "construe" keeps only who speaks to whom and who is named, which is what the
 * scene analysis would otherwise have to ask about.
 */
export function renderFactsLine(facts: CellFacts, mode: 'draft' | 'construe'): string {
  const withIds = mode === 'draft'
  const parts: string[] = []
  const speeches = facts.speeches.slice(0, MAX_SPEECHES)
  for (const speech of speeches) {
    const pair = `${nameOf(speech.speaker, withIds)} → ${nameOf(speech.addressee, withIds)}`
    parts.push(mode === 'draft' ? `speech ${pair}, ${speechShape(speech)}` : `speech ${pair}`)
  }
  if (speeches.length === 0) parts.push('narration only, no speech')
  const trailing = facts.trailingText
  if (mode === 'draft' && trailing) {
    parts.push(
      trailing.endLevel === 0
        ? `narration follows after the level-${trailing.closeLevel} quote closes`
        : `level-${trailing.endLevel} speech continues after the level-${trailing.closeLevel} quote closes`,
    )
  }
  if (facts.participants.length > 0) parts.push(`named: ${names(facts.participants, MAX_NAMED)}`)
  if (facts.impliedSubjects.length > 0) parts.push(`implied subject: ${names(facts.impliedSubjects, MAX_IMPLIED)}`)
  if (mode === 'draft') {
    if (facts.secondPerson) parts.push(`"you" is ${facts.secondPerson === 'mixed' ? 'singular and plural' : facts.secondPerson}`)
    if (facts.question) parts.push('the source asks a question')
    if (facts.negators > 0) parts.push('the source is negated')
    if (facts.numerals > 0) parts.push(`${facts.numerals} numeral${facts.numerals === 1 ? '' : 's'}`)
  }
  return clipLine(parts.join('; '))
}
