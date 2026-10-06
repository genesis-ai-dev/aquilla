// Who's Who in the editor (AQU-1689): what EditorTable hands each row.
//
// One context value per file view, built by `useWhosWho`. It changes only
// when the pack, the cells' refs, the names or the person's view options
// change, never on a keystroke or a hover, so rows reading it stay memoized.
// Hover state lives in `store` and reaches only the mentions it changes.

import { createContext, useContext, useMemo } from "react"
import { alignToPackWords, packWordsFor, type AlignedWord } from "@/lib/bible-data/macula-alignment"
import type { BkpEntityId, BkpRef, BkpTextLayer } from "@/lib/bible-data/pack-types"
import { mentionsIn, type MentionAt, type PeopleIndex } from "@/lib/bible-data/people-index"
import { cellVerses } from "@/lib/bible-data/voice-index"
import type { ImpliedSubjectHintMode, WhosWhoHighlightMode } from "@/lib/store/bible-data-view-prefs"
import type { MentionHighlightStore } from "./mention-highlight-store"
import type { EntityLabeler } from "./useEntityLabels"

export interface WhosWhoContextValue {
  index: PeopleIndex
  /** The pack's words. Null when the text layer did not load: no tints and no Context tab then. */
  text: BkpTextLayer | null
  labelFor: EntityLabeler
  /** A participant's name, a group by its members, or the "unnamed" text. */
  nameOf: (entityId: BkpEntityId) => string
  store: MentionHighlightStore
  /** Marks in the source text. "off" when Who's Who is off, or the person hides them. */
  highlights: WhosWhoHighlightMode
  /** Implied-subject hints before verbs. "off" when Who's Who is off. */
  hints: ImpliedSubjectHintMode
  /** The project offers the Context tab (Original-language context on). */
  contextTab: boolean
  /** Verses that more than one cell of the file covers. */
  shared: ReadonlySet<BkpRef>
  /** Scroll to the first cell of a verse; with `focus`, put keyboard focus on that participant's word there. */
  jumpTo: (ref: BkpRef, focus?: BkpEntityId) => void
  /** Filter the editor to the cells that mention a participant; null while Who's Who is off. */
  showMentionsOf: ((entity: BkpEntityId) => void) | null
}

export const WhosWhoContext = createContext<WhosWhoContextValue | null>(null)

/** A source word that refers to a participant. */
export interface CellMentionWord extends AlignedWord {
  at: MentionAt
}

export interface CellMentionView {
  context: WhosWhoContextValue
  /** The cell's verses. */
  refs: readonly BkpRef[]
  /** The cell's words that refer to someone, in order. */
  words: readonly CellMentionWord[]
}

/**
 * A source cell's mention words, or null when the cell gets no word tints:
 * highlights off, a cell that is not a whole verse (or bridge), or a source
 * whose words are not the pack's (see macula-alignment).
 */
export function useCellMentionWords(ref: string, type: string, sourceText: string): CellMentionView | null {
  const context = useContext(WhosWhoContext)
  return useMemo(() => {
    if (!context || context.highlights === "off" || !context.text) return null
    const verses = cellVerses({ ref, type })
    if (!verses || verses.partial || verses.book !== context.index.book) return null
    const alignment = alignToPackWords(sourceText, packWordsFor(context.text, verses.refs))
    if (!alignment.ok) return null
    const byWord = new Map(mentionsIn(context.index, verses.refs).map((at) => [at.wordId, at]))
    const words = alignment.words.flatMap((word) => {
      const at = byWord.get(word.wordId)
      return at ? [{ ...word, at }] : []
    })
    return words.length > 0 ? { context, refs: verses.refs, words } : null
  }, [context, ref, type, sourceText])
}

export interface CellContextView {
  context: WhosWhoContextValue & { text: BkpTextLayer }
  refs: readonly BkpRef[]
  /** The cell is part of a verse, or shares its verse with another cell. */
  approximate: boolean
}

/** The Context tab's view of a cell, or null when the tab is not offered for it. */
export function useCellContext(ref: string, type: string): CellContextView | null {
  const context = useContext(WhosWhoContext)
  return useMemo(() => {
    if (!context?.contextTab) return null
    const text = context.text
    if (!text) return null
    const verses = cellVerses({ ref, type })
    if (!verses || verses.book !== context.index.book) return null
    const refs = verses.refs.filter((verse) => Object.hasOwn(text.verses, verse))
    if (refs.length === 0) return null
    return {
      context: { ...context, text },
      refs,
      approximate: verses.partial || verses.refs.some((verse) => context.shared.has(verse)),
    }
  }, [context, ref, type])
}
