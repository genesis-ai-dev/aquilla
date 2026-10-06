// Who's Who, the people index (AQU-1689).
//
// Every mention of every participant in one book, from the Bible Knowledge
// Pack's `people` layer, placed in verses and in pericopes (the `structure`
// layer's segments). Pure: no React, no i18n, no network. Built once per
// (pack version, book), like the voice index.
//
// A mention is one Greek or Hebrew word: a name (`explicit`), a pronoun, or a
// verb whose implied subject is the participant (`subject`). Groups are their
// own entities with members; a group mention is never counted as a mention of
// one of its members, and a member's mention never as the group's.
//
// Spec: aquilla-specs 05-user-stories/follow-a-participant-thread.md and
// 04-features/bible-knowledge-layer.md; design doc §6.

import {
  entityGender,
  entityMembers,
  entityNumber,
  entityRole,
  genderClass,
  type EntityGender,
  type EntityNumber,
  type EntityRole,
} from "./entity-facts"
import type {
  BkpEntity,
  BkpEntityId,
  BkpMention,
  BkpPeopleLayer,
  BkpRef,
  BkpStructureLayer,
  BkpTextLayer,
  BkpWord,
  BkpWordId,
} from "./pack-types"
import { refOfWord } from "./versification"

export type MentionKind = BkpMention["kind"]

/** One mention, where it is. */
export interface MentionAt {
  wordId: BkpWordId
  ref: BkpRef
  mention: BkpMention
  /**
   * The word is in the first or second person ("I", "you", "we", "give!"):
   * it refers to the speaker or the listener. False when the text layer did
   * not say.
   */
  firstOrSecondPerson: boolean
}

/** One pericope: an OpenText segment of the book. */
export interface Pericope {
  id: string
  /** The dataset's English title. Data, not interface text. */
  title: string
  from: BkpWordId
  to: BkpWordId
  fromRef: BkpRef
  toRef: BkpRef
}

export interface PeopleIndex {
  book: string
  entities: Readonly<Record<BkpEntityId, BkpEntity>>
  /** Every mention, in word order. */
  mentions: readonly MentionAt[]
  /** Each verse's mentions, in word order. */
  byVerse: ReadonlyMap<BkpRef, readonly MentionAt[]>
  /** Each entity's verses, in order, each once: where previous/next jumps land. */
  refsByEntity: ReadonlyMap<BkpEntityId, readonly BkpRef[]>
  /** The book's pericopes, in order. Empty when the structure layer is missing. */
  pericopes: readonly Pericope[]
}

const REF_RE = /^\S+ (\d+):(\d+)$/

/** A verse's position in its book, for ordering refs: chapter × 1000 + verse. NaN for a bad ref. */
export function verseOrdinal(ref: BkpRef): number {
  const match = REF_RE.exec(ref)
  return match ? Number(match[1]) * 1000 + Number(match[2]) : Number.NaN
}

function isMention(value: unknown): value is BkpMention {
  if (typeof value !== "object" || value === null) return false
  const mention = value as Partial<BkpMention>
  return typeof mention.entity === "string" && typeof mention.kind === "string" && typeof mention.hops === "number"
}

/**
 * First- and second-person pronouns carry the person in their morphology code
 * (personal P-1/P-2, reflexive F-1/F-2, possessive S-1/S-2); verbs carry it
 * in `person`.
 */
const FIRST_OR_SECOND_PERSON_MORPH = /^[PFS]-[12]/

function isFirstOrSecondPerson(word: BkpWord | undefined): boolean {
  if (!word) return false
  return word.person === "first" || word.person === "second" || FIRST_OR_SECOND_PERSON_MORPH.test(word.morph)
}

/**
 * The index for one book. `text` is optional: without it every mention reads
 * as third person, so the ambiguity flag may count a speaker ("I") as a rival
 * for "him".
 */
export function buildPeopleIndex(
  people: BkpPeopleLayer,
  structure: BkpStructureLayer | null,
  text: BkpTextLayer | null = null,
): PeopleIndex {
  const mentions: MentionAt[] = []
  // Word ids sort as strings within a book, so this is reading order.
  for (const wordId of Object.keys(people.mentions).sort()) {
    const mention: unknown = people.mentions[wordId]
    const ref = refOfWord(people.book, wordId)
    if (!ref || !isMention(mention)) continue
    const word = text && Object.hasOwn(text.words, wordId) ? text.words[wordId] : undefined
    mentions.push({ wordId, ref, mention, firstOrSecondPerson: isFirstOrSecondPerson(word) })
  }

  const byVerse = new Map<BkpRef, MentionAt[]>()
  const refsByEntity = new Map<BkpEntityId, BkpRef[]>()
  for (const at of mentions) {
    const verse = byVerse.get(at.ref)
    if (verse) verse.push(at)
    else byVerse.set(at.ref, [at])
    const refs = refsByEntity.get(at.mention.entity)
    if (!refs) refsByEntity.set(at.mention.entity, [at.ref])
    else if (refs[refs.length - 1] !== at.ref) refs.push(at.ref)
  }

  const pericopes: Pericope[] = []
  for (const segment of structure?.segments ?? []) {
    const fromRef = refOfWord(people.book, segment.from)
    const toRef = refOfWord(people.book, segment.to)
    if (!fromRef || !toRef) continue
    pericopes.push({ id: segment.id, title: segment.title, from: segment.from, to: segment.to, fromRef, toRef })
  }
  pericopes.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0))

  return { book: people.book, entities: people.entities, mentions, byVerse, refsByEntity, pericopes }
}

// ── Memo: one index per (pack version, book) ────────────────────────────────

const INDEX_CACHE_LIMIT = 8
interface IndexCacheEntry {
  people: BkpPeopleLayer
  structure: BkpStructureLayer | null
  text: BkpTextLayer | null
  index: PeopleIndex
}
const indexCache = new Map<string, IndexCacheEntry>()

/**
 * The index for one book of one pack version, built once. The layers are kept
 * with it, so a different file under the same key (a test, a refetch) is never
 * answered with the old index.
 */
export function peopleIndexFor(
  version: string,
  people: BkpPeopleLayer,
  structure: BkpStructureLayer | null,
  text: BkpTextLayer | null = null,
): PeopleIndex {
  const key = `${version}/${people.book}`
  const hit = indexCache.get(key)
  if (hit && hit.people === people && hit.structure === structure && hit.text === text) return hit.index
  const index = buildPeopleIndex(people, structure, text)
  indexCache.delete(key)
  indexCache.set(key, { people, structure, text, index })
  if (indexCache.size > INDEX_CACHE_LIMIT) {
    const oldest = indexCache.keys().next()
    if (!oldest.done) indexCache.delete(oldest.value)
  }
  return index
}

// ── Lookups ─────────────────────────────────────────────────────────────────

export function entityOf(index: PeopleIndex, entityId: BkpEntityId): BkpEntity | undefined {
  return Object.hasOwn(index.entities, entityId) ? index.entities[entityId] : undefined
}

/** The mentions in a cell's verses, in reading order. */
export function mentionsIn(index: PeopleIndex, refs: readonly BkpRef[]): MentionAt[] {
  return refs.flatMap((ref) => index.byVerse.get(ref) ?? [])
}

/** One verse's mentions, grouped by entity, each group in word order. */
export function verseMentionsByEntity(index: PeopleIndex, ref: BkpRef): Map<BkpEntityId, MentionAt[]> {
  const out = new Map<BkpEntityId, MentionAt[]>()
  for (const at of index.byVerse.get(ref) ?? []) {
    const list = out.get(at.mention.entity)
    if (list) list.push(at)
    else out.set(at.mention.entity, [at])
  }
  return out
}

/** True when one of the verses mentions the entity itself (not a group it belongs to). */
export function mentionsEntity(index: PeopleIndex, refs: readonly BkpRef[], entityId: BkpEntityId): boolean {
  return refs.some((ref) => (index.byVerse.get(ref) ?? []).some((at) => at.mention.entity === entityId))
}

export type MentionDirection = "previous" | "next"

/**
 * The nearest verse before (or after) a cell's verses that mentions the
 * entity, or null when there is none in the book. A bridge cell counts from
 * its first verse going back and from its last verse going on.
 */
export function adjacentMentionRef(
  index: PeopleIndex,
  entityId: BkpEntityId,
  refs: readonly BkpRef[],
  direction: MentionDirection,
): BkpRef | null {
  const ordinals = refs.map(verseOrdinal).filter((n) => !Number.isNaN(n))
  if (ordinals.length === 0) return null
  const list = index.refsByEntity.get(entityId) ?? []
  if (direction === "next") {
    const last = Math.max(...ordinals)
    return list.find((ref) => verseOrdinal(ref) > last) ?? null
  }
  const first = Math.min(...ordinals)
  for (let i = list.length - 1; i >= 0; i--) {
    if (verseOrdinal(list[i]) < first) return list[i]
  }
  return null
}

/** The pericope a verse is in. A verse a boundary splits belongs to the later pericope. */
export function pericopeAt(index: PeopleIndex, ref: BkpRef): Pericope | null {
  const ordinal = verseOrdinal(ref)
  if (Number.isNaN(ordinal)) return null
  let found: Pericope | null = null
  for (const pericope of index.pericopes) {
    if (verseOrdinal(pericope.fromRef) <= ordinal && ordinal <= verseOrdinal(pericope.toRef)) found = pericope
  }
  return found
}

// ── The cast of a pericope ──────────────────────────────────────────────────

/**
 * Something a translator may want to check, as a reason code:
 *   reintroduce        — the participant's first mention in the pericope is a
 *                        pronoun or an implied subject, so a reader who starts
 *                        here may not know who it is;
 *   possible-ambiguity — a third-person pronoun for this participant, in a
 *                        verse that also mentions another participant of the
 *                        same gender and number. "Active" means referred to
 *                        in that verse in the third person: a speaker ("I")
 *                        or a listener ("you") is never read as "him".
 */
export type PeopleFlag =
  | { code: "reintroduce"; at: MentionAt }
  | { code: "possible-ambiguity"; at: MentionAt; others: readonly BkpEntityId[] }

export interface CastMember {
  entity: BkpEntityId
  /** Undefined when the file mentions an entity it does not define. */
  info: BkpEntity | undefined
  role: EntityRole
  count: number
  kinds: Readonly<Record<MentionKind, number>>
  /** The first mention in the pericope. */
  first: MentionAt
  gender: EntityGender | null
  number: EntityNumber | null
  /** A group's members. A group is listed as a group, never as one of them. */
  members: readonly BkpEntityId[]
  flags: readonly PeopleFlag[]
}

const ROLE_ORDER: Readonly<Record<EntityRole, number>> = { participant: 0, place: 1, other: 2 }

/** Index of the first mention at or after `wordId`. */
function lowerBound(mentions: readonly MentionAt[], wordId: BkpWordId): number {
  let lo = 0
  let hi = mentions.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (mentions[mid].wordId < wordId) lo = mid + 1
    else hi = mid
  }
  return lo
}

function newMember(index: PeopleIndex, at: MentionAt): CastMember & { flags: PeopleFlag[] } {
  const info = entityOf(index, at.mention.entity)
  return {
    entity: at.mention.entity,
    info,
    role: entityRole(info),
    count: 0,
    kinds: { explicit: 0, pronoun: 0, subject: 0 },
    first: at,
    gender: entityGender(info),
    number: entityNumber(info),
    members: entityMembers(info),
    flags: [],
  }
}

function buildCast(index: PeopleIndex, pericope: Pericope): CastMember[] {
  const start = lowerBound(index.mentions, pericope.from)
  const members = new Map<BkpEntityId, CastMember & { flags: PeopleFlag[] }>()
  const verses = new Map<BkpRef, MentionAt[]>()
  for (let i = start; i < index.mentions.length && index.mentions[i].wordId <= pericope.to; i++) {
    const at = index.mentions[i]
    let member = members.get(at.mention.entity)
    if (!member) {
      member = newMember(index, at)
      members.set(at.mention.entity, member)
    }
    member.count++
    const kinds = member.kinds as Record<MentionKind, number>
    if (Object.hasOwn(kinds, at.mention.kind)) kinds[at.mention.kind]++
    const verse = verses.get(at.ref)
    if (verse) verse.push(at)
    else verses.set(at.ref, [at])
  }

  for (const member of members.values()) {
    if (member.role !== "participant") continue
    const { first } = member
    // A pronoun that is the entity's own anchor introduces it ("whoever
    // drinks"): there is nothing earlier to bring back.
    if (first.mention.kind !== "explicit" && member.info?.anchor !== first.wordId) {
      member.flags.push({ code: "reintroduce", at: first })
    }
  }

  for (const verseMentions of verses.values()) {
    const present = new Map<BkpEntityId, string>()
    for (const at of verseMentions) {
      const member = members.get(at.mention.entity)
      const gender = genderClass(member?.gender ?? null)
      if (!member || member.role !== "participant" || gender === null || member.number === null) continue
      if (at.firstOrSecondPerson) continue
      present.set(member.entity, `${gender}/${member.number}`)
    }
    const flagged = new Set<BkpEntityId>()
    for (const at of verseMentions) {
      if (at.mention.kind !== "pronoun" || at.firstOrSecondPerson || flagged.has(at.mention.entity)) continue
      // A pronoun that introduces its own referent ("whoever") refers to
      // nobody else, so it cannot be read as somebody else either.
      if (members.get(at.mention.entity)?.info?.anchor === at.wordId) continue
      const agreement = present.get(at.mention.entity)
      if (agreement === undefined) continue
      const others = [...present].filter(([id, value]) => id !== at.mention.entity && value === agreement)
      if (others.length === 0) continue
      flagged.add(at.mention.entity)
      members.get(at.mention.entity)?.flags.push({
        code: "possible-ambiguity",
        at,
        others: others.map(([id]) => id),
      })
    }
  }

  return [...members.values()].sort(
    (a, b) =>
      ROLE_ORDER[a.role] - ROLE_ORDER[b.role] ||
      b.count - a.count ||
      (a.first.wordId < b.first.wordId ? -1 : a.first.wordId > b.first.wordId ? 1 : 0),
  )
}

const castCache = new WeakMap<PeopleIndex, Map<string, readonly CastMember[]>>()

/**
 * Who a pericope mentions: participants first (most mentioned first), then
 * places, then anything else. Each with counts, the first mention, gender and
 * number where known, a group's members, and its flags. Built once per
 * pericope.
 */
export function pericopeCast(index: PeopleIndex, pericope: Pericope): readonly CastMember[] {
  let byPericope = castCache.get(index)
  if (!byPericope) {
    byPericope = new Map()
    castCache.set(index, byPericope)
  }
  const cached = byPericope.get(pericope.id)
  if (cached) return cached
  const cast = buildCast(index, pericope)
  byPericope.set(pericope.id, cast)
  return cast
}

/** Participants that get their own thread color in a pericope; the rest stay neutral. */
export const THREAD_SLOTS = 6

/** The thread color slot (1–6) of a participant in the pericope a verse is in, or null. */
export function threadSlot(index: PeopleIndex, ref: BkpRef, entityId: BkpEntityId): number | null {
  const pericope = pericopeAt(index, ref)
  if (!pericope) return null
  const participants = pericopeCast(index, pericope).filter((member) => member.role === "participant")
  const position = participants.findIndex((member) => member.entity === entityId)
  return position >= 0 && position < THREAD_SLOTS ? position + 1 : null
}
