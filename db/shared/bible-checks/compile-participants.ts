// Who a cell's source names and refers to (AQU-1699, check pack B).
//
// Built with the cell's expectation, once per file (./compile.ts), from the
// pack's people layer (each word's mention: explicit, pronoun or subject), its
// text layer (which words are names, and each word's person and number) and
// the speeches touching the cell (speaker, addressee). Nothing here reads any
// cell's text.
//
// Clusivity (P9) is decided from data, never guessed. "We" is the 1st-person
// plural word's referent group S (its members, when the pack lists them); the
// addressees R are the speech's addressee and the referents of the speech's
// 2nd-person words in the cell. R inside S is inclusive; R apart from S is
// exclusive, but only when that is certain: S's members are all known, or R
// holds a group of its own (JHN 4:22: ἡμεῖς = Jews + Jesus, ὑμεῖς =
// Samaritans). "We" resolved to the speaker alone, a partial overlap, or a
// person who might belong to one of S's groups is unknown, and P9 skips it.
//
// Relative imports only, no DOM: shared with the workers.

import { isNameWord } from './agreed-names'
import { nameFormKey } from './name-forms'
import type {
  CellParticipants,
  Clusivity,
  DivineMention,
  FirstPluralMention,
  GroupMention,
  NameMention,
  NameTable,
  PeopleEntityInput,
  PeopleLayerInput,
  PeopleMentionInput,
} from './participant-types'
import type { SpeechInput, TextLayerInput, TextWordInput } from './types'

export interface ParticipantCompileInput {
  people: PeopleLayerInput
  text: TextLayerInput | null | undefined
  names: NameTable
  /** The cell's verses. */
  refs: readonly string[]
  /** The verses just before and after the cell in the pack. */
  previous: string | null
  next: string | null
  /** The word-id prefix of a verse's words ("n43004016"); null when the pack lacks the verse. */
  verseKey: (ref: string) => string | null
  /** The speeches touching the cell, with speaker and addressee. */
  speeches: readonly SpeechInput[]
}

/** A mention of one of these can stand for several people. */
const GROUP_TYPES: ReadonlySet<string> = new Set(['group', 'local-group'])
/** One being each: a group of these has a size. */
const INDIVIDUAL_TYPES: ReadonlySet<string> = new Set(['person', 'local-person', 'deity'])
/** Below this, who "we" are or who is addressed is too unsure to decide clusivity. */
const MIN_CLUSIVITY_CONF = 0.6
/** The largest "few" a paucal form covers. */
export const MAX_PAUCAL = 10
const JESUS = 'person:Jesus.2'
const HOLY_SPIRIT = 'deity:HolySpirit'

type MentionEntry = readonly [wordId: string, mention: PeopleMentionInput]

function own<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined
}

function dedupe(values: Iterable<string>): string[] {
  return [...new Set(values)]
}

const mentionIndexes = new WeakMap<PeopleLayerInput, Map<string, MentionEntry[]>>()

/** Mentions per verse, keyed by the verse part of the word id, in reading order. Built once per layer. */
function mentionsByVerse(people: PeopleLayerInput): Map<string, MentionEntry[]> {
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

/** The entity and, for a group the pack minted, its members (two levels down). */
function withMembers(entities: Readonly<Record<string, PeopleEntityInput>>, ids: Iterable<string>): Set<string> {
  const out = new Set<string>()
  const add = (id: string, depth: number) => {
    if (out.has(id)) return
    out.add(id)
    if (depth > 0) for (const member of own(entities, id)?.members ?? []) add(member, depth - 1)
  }
  for (const id of ids) add(id, 2)
  return out
}

function isFirstPlural(word: TextWordInput): boolean {
  if (word.person === 'first' && word.number === 'plural') return true
  return word.class === 'pron' && /^P-1.P/.test(word.morph ?? '')
}

/** A 2nd-person verb or personal pronoun (σύ, ὑμεῖς); a possessive's number is its noun's. */
function secondPersonNumber(word: TextWordInput): 'singular' | 'plural' | null {
  const second = word.person === 'second' || (word.class === 'pron' && /^P-2/.test(word.morph ?? ''))
  return second && (word.number === 'singular' || word.number === 'plural') ? word.number : null
}

function isImperative(word: TextWordInput): boolean {
  return word.mood === 'imperative' || /^V-..M/.test(word.morph ?? '')
}

/** The innermost speech whose words include `wordId`. */
function speechAt(speeches: readonly SpeechInput[], wordId: string): SpeechInput | null {
  let best: SpeechInput | null = null
  for (const speech of speeches) {
    if (speech.from <= wordId && wordId <= speech.to && (!best || speech.depth > best.depth)) best = speech
  }
  return best
}

function clusivityOf(
  entities: Readonly<Record<string, PeopleEntityInput>>,
  mention: PeopleMentionInput | undefined,
  addressees: readonly string[],
): { clusivity: Clusivity | null; referents: string[] } {
  const entity = mention ? own(entities, mention.entity) : undefined
  // "We" resolved to one person (the speaker) has lost its group.
  if (!mention || !entity || mention.conf < MIN_CLUSIVITY_CONF || !GROUP_TYPES.has(entity.type)) {
    return { clusivity: null, referents: mention ? [mention.entity] : [] }
  }
  const referents = withMembers(entities, [mention.entity])
  const listed = [...referents]
  if (addressees.length === 0) return { clusivity: null, referents: listed }
  const inside = addressees.filter((id) => referents.has(id))
  if (inside.length === addressees.length) return { clusivity: 'inclusive', referents: listed }
  if (inside.length > 0) return { clusivity: null, referents: listed }
  // Apart from S. Certain only if S's membership is fully known, or the addressees are a group of their own.
  const openGroup = listed.some((id) => GROUP_TYPES.has(own(entities, id)?.type ?? '') && !own(entities, id)?.members?.length)
  const contrast = addressees.some((id) => GROUP_TYPES.has(own(entities, id)?.type ?? ''))
  return { clusivity: !openGroup || contrast ? 'exclusive' : null, referents: listed }
}

/** The number of a group the pack minted, when every member is one being. */
function groupSize(entities: Readonly<Record<string, PeopleEntityInput>>, id: string): number | null {
  const members = own(entities, id)?.members
  if (!members || members.length < 2 || members.length > MAX_PAUCAL) return null
  return members.every((member) => INDIVIDUAL_TYPES.has(own(entities, member)?.type ?? '')) ? members.length : null
}

/** The participant facts for one cell. */
export function compileParticipants(input: ParticipantCompileInput): CellParticipants {
  const { people, text, names } = input
  const { entities } = people
  const index = mentionsByVerse(people)
  const verseMentions = (ref: string | null): MentionEntry[] => {
    const key = ref ? input.verseKey(ref) : null
    return (key && index.get(key)) || []
  }
  const cellMentions = input.refs.flatMap(verseMentions)
  const explicit = new Set(cellMentions.filter(([, m]) => m.kind === 'explicit').map(([, m]) => m.entity))

  const named: NameMention[] = []
  const impliedSubjects: { entity: string; word: string }[] = []
  for (const [wordId, mention] of cellMentions) {
    if (mention.kind === 'subject' && !explicit.has(mention.entity)) {
      if (!impliedSubjects.some((s) => s.entity === mention.entity)) impliedSubjects.push({ entity: mention.entity, word: wordId })
    }
    const word = text ? own(text.words, wordId) : undefined
    if (mention.kind === 'explicit' && isNameWord(word)) {
      named.push({ entity: mention.entity, word: wordId, lemma: word.lemma, form: nameFormKey(word.lemma) })
    }
  }
  const nearby = [input.previous, input.next].flatMap(verseMentions).filter(([, m]) => m.kind === 'subject')

  const words: [string, TextWordInput][] = []
  for (const ref of input.refs) {
    for (const wordId of (text && own(text.verses, ref)) || []) {
      const word = own(text?.words ?? {}, wordId)
      if (word) words.push([wordId, word])
    }
  }

  const numbers = new Set<string>()
  let explicitSecond = false
  const firstPlural: FirstPluralMention[] = []
  const groups: GroupMention[] = []
  const divine: DivineMention[] = []
  for (const [wordId, word] of words) {
    const second = secondPersonNumber(word)
    if (second) {
      numbers.add(second)
      if (word.class === 'pron' || !isImperative(word)) explicitSecond = true
    }
    const mention = own(people.mentions, wordId)
    if (isFirstPlural(word)) {
      const speech = speechAt(input.speeches, wordId)
      const addressees = speech ? addresseesOf(speech, words, people) : []
      const { clusivity, referents } = clusivityOf(entities, mention, addressees)
      firstPlural.push({ word: wordId, entity: mention?.entity ?? null, clusivity, referents, addressees })
    }
    if (mention && mention.kind !== 'explicit' && word.number === 'plural') {
      const size = groupSize(entities, mention.entity)
      if (size !== null) groups.push({ word: wordId, entity: mention.entity, size })
    }
    if (mention && word.lemma === 'κύριος' && word.case !== 'vocative') {
      if (mention.entity === JESUS) divine.push({ word: wordId, kind: 'kyrios-jesus' })
      else if (own(entities, mention.entity)?.type === 'deity' && mention.entity !== HOLY_SPIRIT) divine.push({ word: wordId, kind: 'kyrios-god' })
    }
    if (mention?.entity === HOLY_SPIRIT && word.lemma === 'πνεῦμα') divine.push({ word: wordId, kind: 'holy-spirit' })
  }

  return {
    names,
    named,
    mentioned: [...withMembers(entities, cellMentions.map(([, m]) => m.entity))],
    impliedSubjects,
    nearbySubjects: [...withMembers(entities, nearby.map(([, m]) => m.entity))],
    voices: dedupe(input.speeches.flatMap((s) => [s.speaker, s.addressee]).filter((id): id is string => !!id)),
    secondPerson:
      numbers.size === 0
        ? null
        : { number: numbers.size > 1 ? 'mixed' : numbers.has('singular') ? 'singular' : 'plural', explicit: explicitSecond },
    firstPlural,
    groups,
    divine,
  }
}

/**
 * The speech's addressee, and who its 2nd-person words in this cell refer to;
 * a group addressed is its members. One person speaking is never their own
 * addressee (the pack has Paul addressing Paul in ACT 26:6); a group can be, when
 * it reasons among itself (LUK 20:5).
 */
function addresseesOf(speech: SpeechInput, cellWords: readonly [string, TextWordInput][], people: PeopleLayerInput): string[] {
  const ids: string[] = []
  if (speech.addressee && (speech.addresseeConf ?? 0) >= MIN_CLUSIVITY_CONF) ids.push(speech.addressee)
  for (const [wordId, word] of cellWords) {
    if (wordId < speech.from || wordId > speech.to || !secondPersonNumber(word)) continue
    const mention = own(people.mentions, wordId)
    if (mention && mention.conf >= MIN_CLUSIVITY_CONF) ids.push(mention.entity)
  }
  const speaker = speech.speaker && !GROUP_TYPES.has(own(people.entities, speech.speaker)?.type ?? '') ? speech.speaker : null
  const out = new Set<string>()
  for (const id of ids) {
    const members = own(people.entities, id)?.members
    if (members?.length) for (const member of members) out.add(member)
    else out.add(id)
  }
  if (speaker) out.delete(speaker)
  return [...out]
}
