// Who a reader of the translation must be able to track (AQU-1701): the pack
// facts behind two Jev questions. Built from the people and text layers and
// the pericope boundaries, never from a cell's text.
//
//   P11  A participant's FIRST mention after a pericope boundary (an OpenText
//        segment; a SIL OTN section in the OT) falls in the cell, and the
//        Greek uses a name there (Ἀνδρέας). A reader who starts the pericope
//        here must be told who this is (TN "Introduction of New and Old
//        Participants").
//   P13  The cell refers to a participant only as the implied subject of a
//        third-person verb, and another active participant of the cell has
//        the same gender and number: a translation's "he" may point at either.
//
// Relative imports only, no DOM: shared with the workers.

import { isNameWord } from './agreed-names'
import type {
  AmbiguousSubject,
  ParticipantIntroduction,
  PeopleEntityInput,
  PeopleLayerInput,
  PeopleMentionInput,
} from './participant-types'
import type { TextLayerInput, TextWordInput } from './types'

export type MentionEntry = readonly [wordId: string, mention: PeopleMentionInput]

/** A pericope: its first and last Macula word. */
export interface SegmentInput {
  from: string
  to: string
}

/** The participants a reader tracks: people and groups. Places, things and deities are introduced or confused otherwise. */
const ONE = new Set(['person', 'local-person'])
const MANY = new Set(['group', 'local-group'])

function own<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined
}

/** The pack's gender, as ACAI (male, female) or the grammar (masculine, feminine, neuter) gives it. */
function genderOf(entity: PeopleEntityInput): 'm' | 'f' | 'n' | null {
  switch (entity.gender) {
    case 'male':
    case 'masculine':
      return 'm'
    case 'female':
    case 'feminine':
      return 'f'
    case 'neuter':
      return 'n'
    default:
      return null
  }
}

/** The pack mints some things as local persons ("water", JHN 4:10): a neuter person is one of those. */
function isParticipant(entity: PeopleEntityInput | undefined): entity is PeopleEntityInput {
  if (!entity) return false
  if (ONE.has(entity.type)) return genderOf(entity) !== 'n'
  return MANY.has(entity.type)
}

/**
 * Gender and number as one key ("m:one", "f:many"); null when either is
 * unknown, so nobody is called a look-alike on a guess. Exported for the Jev
 * shadow eval, which picks the English pronoun to plant from it.
 */
export function lookAlikeKey(entity: PeopleEntityInput | undefined): string | null {
  if (!isParticipant(entity)) return null
  const gender = genderOf(entity)
  return gender ? `${gender}:${ONE.has(entity.type) ? 'one' : 'many'}` : null
}

// ── P11: first mentions after a pericope boundary ──────────────────────────

const firstMentionCache = new WeakMap<PeopleLayerInput, WeakMap<readonly SegmentInput[], Set<string>>>()

/** The mention words that are their entity's first mention in their pericope. Built once per layer and segment list. */
function firstMentions(people: PeopleLayerInput, segments: readonly SegmentInput[]): Set<string> {
  let bySegments = firstMentionCache.get(people)
  if (!bySegments) {
    bySegments = new WeakMap()
    firstMentionCache.set(people, bySegments)
  }
  const cached = bySegments.get(segments)
  if (cached) return cached
  // Macula word ids sort in reading order within a book.
  const sorted = [...segments].sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0))
  const out = new Set<string>()
  let at = 0
  let seen = new Set<string>()
  for (const wordId of Object.keys(people.mentions).sort()) {
    while (at < sorted.length && sorted[at].to < wordId) {
      at++
      seen = new Set()
    }
    const segment = sorted[at]
    const entity = own(people.mentions, wordId)?.entity
    if (!segment || wordId < segment.from || !entity || seen.has(entity)) continue
    seen.add(entity)
    out.add(wordId)
  }
  bySegments.set(segments, out)
  return out
}

/**
 * P11: the participants whose first mention in their pericope is a name in
 * `mentions` (one cell's, in reading order). Empty without pericopes or the
 * text layer, which says which words are names.
 */
export function introductionsIn(
  mentions: readonly MentionEntry[],
  people: PeopleLayerInput,
  text: TextLayerInput | null | undefined,
  segments: readonly SegmentInput[] | undefined,
): ParticipantIntroduction[] {
  if (!text || !segments || segments.length === 0) return []
  const first = firstMentions(people, segments)
  const out: ParticipantIntroduction[] = []
  for (const [wordId, mention] of mentions) {
    if (mention.kind !== 'explicit' || !first.has(wordId) || out.some((i) => i.entity === mention.entity)) continue
    if (isParticipant(own(people.entities, mention.entity)) && isNameWord(own(text.words, wordId))) {
      out.push({ entity: mention.entity, word: wordId })
    }
  }
  return out
}

// ── P13: implied subjects with look-alikes ─────────────────────────────────

/** A verb's English gloss as the question uses it: "[were] coming" → "were coming". */
function glossOf(word: TextWordInput): string | null {
  const gloss = (word.english ?? word.gloss ?? '').replace(/[[\]]/gu, '').replace(/\s+/gu, ' ').trim()
  return gloss || null
}

/**
 * P13: the implied subjects of third-person verbs that the cell never names,
 * when another active participant has the same gender and number. Active:
 * every participant the cell's source mentions, and the speakers and
 * addressees of its speeches (`voices`). One entry per participant, at its
 * first such verb; empty without the text layer, which gives the verb.
 */
export function ambiguousSubjectsIn(
  mentions: readonly MentionEntry[],
  people: PeopleLayerInput,
  text: TextLayerInput | null | undefined,
  voices: readonly string[],
): AmbiguousSubject[] {
  if (!text) return []
  const byKey = new Map<string, string[]>()
  for (const id of new Set([...mentions.map(([, m]) => m.entity), ...voices])) {
    const key = lookAlikeKey(own(people.entities, id))
    if (key) byKey.set(key, [...(byKey.get(key) ?? []), id])
  }
  const named = new Set(mentions.filter(([, m]) => m.kind === 'explicit').map(([, m]) => m.entity))
  const out: AmbiguousSubject[] = []
  for (const [wordId, mention] of mentions) {
    if (mention.kind !== 'subject' || named.has(mention.entity) || out.some((s) => s.entity === mention.entity)) continue
    const word = own(text.words, wordId)
    const gloss = word?.person === 'third' ? glossOf(word) : null
    const key = lookAlikeKey(own(people.entities, mention.entity))
    const peers = key ? (byKey.get(key) ?? []).filter((id) => id !== mention.entity) : []
    if (gloss && peers.length > 0) out.push({ entity: mention.entity, word: wordId, gloss, peers })
  }
  return out
}
