// Translation helps (AQU-1695): the pack's `notes` and `terms` layers, as
// the cell's Context tab reads them.
//
// `notes` holds unfoldingWord Translation Notes (TN) and Translation
// Questions (TQ); `terms` tags words with Translation Words articles and
// ACAI keyterms. Pure: no React, no i18n, no network. The pack client checks
// only each file's envelope (see pack-types), so every item is checked here
// and one that is malformed is skipped, never thrown on.
//
// Spec: aquilla-specs 04-features/bible-knowledge-layer.md; the contract is
// bible-wiki pipeline/src/bkp/README.md ("notes", "terms").

import type {
  BkpNote,
  BkpNotesLayer,
  BkpQuestion,
  BkpRef,
  BkpTerm,
  BkpTermId,
  BkpTermsLayer,
  BkpWordId,
} from "./pack-types"
import { verseOrdinal } from "./people-index"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isNote(value: unknown): value is BkpNote {
  return isRecord(value) && typeof value.id === "string" && typeof value.ref === "string" && typeof value.text === "string"
}

function isQuestion(value: unknown): value is BkpQuestion {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.q === "string" &&
    typeof value.a === "string" &&
    Array.isArray(value.refs) &&
    value.refs.length > 0 &&
    value.refs.every((ref) => typeof ref === "string")
  )
}

/** A note's words; none when the file has none or they are not word ids. */
export function noteWords(note: BkpNote): BkpWordId[] {
  const words: unknown = note.words
  return Array.isArray(words) ? words.filter((word): word is BkpWordId => typeof word === "string") : []
}

/**
 * The note's quote is in one place in the verse, so its words can be
 * highlighted. An ambiguous note also has words (the shortest placement), but
 * they may be the wrong ones, so it is not highlighted.
 */
export function isAnchoredNote(note: BkpNote): boolean {
  return note.anchor === "anchored" && noteWords(note).length > 0
}

interface Placed<T> {
  item: T
  /** Its place in the file, which is verse order. */
  position: number
}

export interface NotesIndex {
  book: string
  /** Notes on one verse, by verse. */
  notesByVerse: ReadonlyMap<BkpRef, readonly Placed<BkpNote>[]>
  /** Notes on a range of verses (with an `endRef`). Few: General Information and the like. */
  rangeNotes: readonly (Placed<BkpNote> & { from: number; to: number })[]
  questionsByVerse: ReadonlyMap<BkpRef, readonly Placed<BkpQuestion>[]>
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key)
  if (list) list.push(value)
  else map.set(key, [value])
}

export function buildNotesIndex(layer: BkpNotesLayer): NotesIndex {
  const notesByVerse = new Map<BkpRef, Placed<BkpNote>[]>()
  const rangeNotes: (Placed<BkpNote> & { from: number; to: number })[] = []
  layer.notes.forEach((value: unknown, position) => {
    if (!isNote(value)) return
    const endRef: unknown = value.endRef
    if (typeof endRef === "string" && endRef !== value.ref) {
      const from = verseOrdinal(value.ref)
      const to = verseOrdinal(endRef)
      if (!Number.isNaN(from) && !Number.isNaN(to) && from <= to) {
        rangeNotes.push({ item: value, position, from, to })
        return
      }
    }
    push(notesByVerse, value.ref, { item: value, position })
  })
  const questionsByVerse = new Map<BkpRef, Placed<BkpQuestion>[]>()
  layer.questions.forEach((value: unknown, position) => {
    if (!isQuestion(value)) return
    for (const ref of new Set(value.refs)) push(questionsByVerse, ref, { item: value, position })
  })
  return { book: layer.book, notesByVerse, rangeNotes, questionsByVerse }
}

const indexCache = new WeakMap<BkpNotesLayer, NotesIndex>()

/** The index of one notes file, built once. */
export function notesIndexFor(layer: BkpNotesLayer): NotesIndex {
  let index = indexCache.get(layer)
  if (!index) {
    index = buildNotesIndex(layer)
    indexCache.set(layer, index)
  }
  return index
}

/** Items on any of `refs`, each once, in file order. */
function inOrder<T extends { id: string }>(placed: Iterable<Placed<T>>): T[] {
  const byId = new Map<string, Placed<T>>()
  for (const entry of placed) if (!byId.has(entry.item.id)) byId.set(entry.item.id, entry)
  return [...byId.values()].sort((a, b) => a.position - b.position).map((entry) => entry.item)
}

export interface CellNotes {
  /** Highlighted in the word list, numbered from 1 in this order. */
  anchored: readonly BkpNote[]
  /** Every other note on the verses: ambiguous, unanchored, or without a quote. */
  other: readonly BkpNote[]
}

/** The notes on a cell's verses, a range note included on every verse it covers. */
export function notesFor(index: NotesIndex, refs: readonly BkpRef[]): CellNotes {
  const placed: Placed<BkpNote>[] = []
  for (const ref of refs) {
    placed.push(...(index.notesByVerse.get(ref) ?? []))
    const ordinal = verseOrdinal(ref)
    for (const range of index.rangeNotes) {
      if (range.from <= ordinal && ordinal <= range.to) placed.push(range)
    }
  }
  const notes = inOrder(placed)
  return { anchored: notes.filter(isAnchoredNote), other: notes.filter((note) => !isAnchoredNote(note)) }
}

/** The questions on a cell's verses, in file order. */
export function questionsFor(index: NotesIndex, refs: readonly BkpRef[]): BkpQuestion[] {
  return inOrder(refs.flatMap((ref) => index.questionsByVerse.get(ref) ?? []))
}

const REF_PARTS_RE = /^(\S+) (\d+):(\d+)$/

/**
 * A range of verses written short, as a reference: "JHN 4:14–15", "JHN
 * 4:54–5:2", or one ref when both ends are the same verse. Data, not
 * interface text: the caller puts it in a sentence.
 */
export function refRange(first: BkpRef, last: BkpRef): string {
  if (first === last) return first
  const a = REF_PARTS_RE.exec(first)
  const b = REF_PARTS_RE.exec(last)
  if (!a || !b || a[1] !== b[1]) return `${first}–${last}`
  return a[2] === b[2] ? `${first}–${b[3]}` : `${first}–${b[2]}:${b[3]}`
}

/** The verses a question covers, as a range; null for one verse. */
export function questionRange(question: BkpQuestion): string | null {
  if (question.refs.length < 2) return null
  return refRange(question.refs[0], question.refs[question.refs.length - 1])
}

/** The verses a note covers, as a range; null for one verse. */
export function noteRange(note: BkpNote): string | null {
  const endRef: unknown = note.endRef
  return typeof endRef === "string" && endRef !== note.ref ? refRange(note.ref, endRef) : null
}

/**
 * A note's text as paragraphs. Pack 1.1.0 keeps some paragraph breaks as the
 * two characters "\" and "n" ("General Information:\n\nVerses …"); they and
 * real line breaks both split paragraphs.
 */
export function noteParagraphs(text: string): string[] {
  return text
    .split(/(?:\\n|\r?\n)+/)
    .map((part) => part.trim())
    .filter((part) => part !== "")
}

// ── Key terms ───────────────────────────────────────────────────────────────

export interface WordTerm {
  id: BkpTermId
  term: BkpTerm
}

function isTerm(value: unknown): value is BkpTerm {
  return isRecord(value) && typeof value.title === "string" && value.title.trim() !== ""
}

/** The key terms a word carries, in the file's order; none for an untagged word. */
export function termsOfWord(layer: BkpTermsLayer, wordId: BkpWordId): WordTerm[] {
  const ids: unknown = Object.hasOwn(layer.words, wordId) ? layer.words[wordId] : undefined
  if (!Array.isArray(ids)) return []
  return ids.flatMap((id: unknown) => {
    if (typeof id !== "string" || !Object.hasOwn(layer.terms, id)) return []
    const term: unknown = layer.terms[id]
    return isTerm(term) ? [{ id, term }] : []
  })
}
