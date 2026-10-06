// Who's Who in the editor (AQU-1689): what EditorTable hands each row.
//
// One context value per file view, built by `useWhosWho`. It changes only
// when the pack, the cells' refs, the names, the person's view options or the
// stored alignment change, never on a keystroke or a hover, so rows reading
// it stay memoized. Hover state lives in `store` and reaches only the
// mentions it changes.
//
// AQU-1694: a source whose words are not the pack's (an English Bible) gets
// its mention words through Bridge 1, the stored alignment; the target column
// gets tints through Bridges 1+2 (useCellTargetTints).

import { createContext, useCallback, useContext, useEffect, useMemo, useSyncExternalStore, type RefObject } from "react"
import {
  directTokenLinks,
  EXACT_PAIRS,
  spansFromLinks,
  targetSpans,
  wordsFromSpans,
  type BridgedWord,
} from "@/lib/bible-data/bridge-mentions"
import { alwaysDottedWords, type WordTokenLink } from "@/lib/bible-data/bridge-compose"
import { tokenize } from "@/lib/completion/tokenize"
import { contentHash } from "@/lib/dcs/content-hash"
import { alignToPackWords, packWordsFor } from "@/lib/bible-data/macula-alignment"
import type { BkpEntityId, BkpRef, BkpTextLayer } from "@/lib/bible-data/pack-types"
import { mentionsIn, threadSlot, type MentionAt, type PeopleIndex } from "@/lib/bible-data/people-index"
import { cellVerses, type CellVerses } from "@/lib/bible-data/voice-index"
import type { ImpliedSubjectHintMode, WhosWhoHighlightMode } from "@/lib/store/bible-data-view-prefs"
import type { MentionHighlightStore } from "./mention-highlight-store"
import type { CellSourceLinks } from "./source-alignment-store"
import type { TargetBridge } from "./target-bridge"
import { registerTargetTints, type TintRun } from "./target-tint-layer"
import type { EntityLabeler } from "./useEntityLabels"

/** The bridges Who's Who reads through (AQU-1694). */
export interface WhosWhoBridges {
  /** Bridge 1: the stored links per source cell, for a source that is not the pack's words. */
  source: ReadonlyMap<string, CellSourceLinks> | null
  /** Bridge 2 (source → target) for this editor; null while target tints are off. */
  target: TargetBridge | null
}

export interface WhosWhoContextValue {
  index: PeopleIndex
  /** The pack's words. Null when the text layer did not load: no tints and no Context tab then. */
  text: BkpTextLayer | null
  labelFor: EntityLabeler
  /** A participant's name, a group by its members, or the "unnamed" text. */
  nameOf: (entityId: BkpEntityId) => string
  /**
   * AQU-1695: the name one mention shows: a deity's form at that word when
   * the pack gives one (slice 3: θεός → "God"), else `nameOf` its entity.
   */
  mentionName: (at: MentionAt) => string
  store: MentionHighlightStore
  /** Marks in the source text. "off" when Who's Who is off, or the person hides them. */
  highlights: WhosWhoHighlightMode
  /** Implied-subject hints before verbs. "off" when Who's Who is off. */
  hints: ImpliedSubjectHintMode
  /** The project offers the Context tab (Original-language context on). */
  contextTab: boolean
  /**
   * AQU-1695: the Context tab shows Translation Notes and Questions
   * (Translation helps on). Their layer loads when the tab first opens.
   */
  helps: boolean
  /** AQU-1695: the Context tab shows key-term chips (Key terms on). */
  terms: boolean
  /** Verses that more than one cell of the file covers. */
  shared: ReadonlySet<BkpRef>
  /** Scroll to the first cell of a verse; with `focus`, put keyboard focus on that participant's word there. */
  jumpTo: (ref: BkpRef, focus?: BkpEntityId) => void
  /** Filter the editor to the cells that mention a participant; null while Who's Who is off. */
  showMentionsOf: ((entity: BkpEntityId) => void) | null
  bridges: WhosWhoBridges
}

export const WhosWhoContext = createContext<WhosWhoContextValue | null>(null)

/** A source word that refers to a participant. */
export interface CellMentionWord extends BridgedWord {
  at: MentionAt
  /** Placed through the stored word alignment (Bridge 1), not by the pack's own words. */
  bridged: boolean
}

export interface CellMentionView {
  context: WhosWhoContextValue
  /** The cell's verses. */
  refs: readonly BkpRef[]
  /** The cell's words that refer to someone, in order. */
  words: readonly CellMentionWord[]
}

/** Where a cell's verses are: whole verses of the pack's book, or null. */
function wholeVerses(context: WhosWhoContextValue, ref: string, type: string): CellVerses | null {
  const verses = cellVerses({ ref, type })
  return verses && !verses.partial && verses.book === context.index.book ? verses : null
}

/** Bridge 1 for a cell: the pack's own words (a Greek source), else the stored links for this exact text. */
function bridge1For(
  context: WhosWhoContextValue & { text: BkpTextLayer },
  cellId: string,
  refs: readonly BkpRef[],
  sourceText: string,
): { links: readonly WordTokenLink[]; trainedPairs: number; bridged: boolean } | null {
  const direct = alignToPackWords(sourceText, packWordsFor(context.text, refs))
  if (direct.ok) return { links: directTokenLinks(sourceText, direct.words), trainedPairs: EXACT_PAIRS, bridged: false }
  // Text with USFM markers renders differently from what was aligned: no tints there.
  if (direct.reason === "markup") return null
  const stored = context.bridges.source?.get(cellId)
  if (!stored || stored.sourceHash !== contentHash(sourceText)) return null
  return { links: stored.links, trainedPairs: stored.trainedPairs, bridged: true }
}

/**
 * A source cell's mention words, or null when the cell gets no word tints:
 * highlights off, a cell that is not a whole verse (or bridge), or a source
 * whose words are neither the pack's (see macula-alignment) nor aligned to
 * them (Bridge 1) for the text the cell has now.
 */
export function useCellMentionWords(cellId: string, ref: string, type: string, sourceText: string): CellMentionView | null {
  const context = useContext(WhosWhoContext)
  return useMemo(() => {
    if (!context || context.highlights === "off" || !context.text) return null
    const verses = wholeVerses(context, ref, type)
    if (!verses) return null
    const withText = { ...context, text: context.text }
    const byWord = new Map(mentionsIn(context.index, verses.refs).map((at) => [at.wordId, at]))
    const direct = alignToPackWords(sourceText, packWordsFor(context.text, verses.refs))
    let placed: BridgedWord[] | null
    let bridged = false
    if (direct.ok) {
      placed = direct.words.map((word) => ({ ...word, approximate: false }))
    } else {
      const bridge = bridge1For(withText, cellId, verses.refs, sourceText)
      if (!bridge) return null
      bridged = bridge.bridged
      placed = wordsFromSpans(
        sourceText,
        // AQU-1700: an OT pronoun placed by the alignment draws dotted at any confidence.
        spansFromLinks(bridge.links, bridge.trainedPairs, (id) => byWord.has(id), alwaysDottedWords(context.text)),
      )
    }
    // AQU-1700: a Hebrew word written whole carries all its morphemes, so
    // two of them may name people ("her mother-in-law": the noun and its
    // suffix). One mention per word, the first, as spansFromLinks keeps the
    // first of two equally sure links: the word renders once.
    const taken = new Set<number>()
    const words = (placed ?? []).flatMap((word) => {
      const at = byWord.get(word.wordId)
      if (!at || taken.has(word.start)) return []
      taken.add(word.start)
      return [{ ...word, at, bridged }]
    })
    return words.length > 0 ? { context, refs: verses.refs, words } : null
  }, [context, cellId, ref, type, sourceText])
}

const noSubscribe = () => () => {}

/**
 * Tint the participants in a row's rendered target text (`root`), through
 * Bridges 1+2. Asks Bridge 2 for the row's chapter when it has no links for
 * these texts yet. Draws nothing while highlights are off, Bridge 2 is not
 * running, or the row is not showing its read-only text (`shown` false: the
 * row's editor is open; see target-tint-layer).
 */
export function useCellTargetTints(
  root: RefObject<HTMLElement | null>,
  shown: boolean,
  cellId: string,
  ref: string,
  type: string,
  sourceText: string,
  targetText: string,
): void {
  const context = useContext(WhosWhoContext)
  const bridge = context?.bridges.target ?? null
  // This cell's own answer: the same object until it changes, so a chapter
  // arriving re-renders only the rows it answers.
  const readLinks = useCallback(
    () => bridge?.linksFor(cellId, sourceText, targetText),
    [bridge, cellId, sourceText, targetText],
  )
  const bridge2 = useSyncExternalStore(bridge ? bridge.subscribe : noSubscribe, readLinks, readLinks)
  const plan = useMemo(() => {
    if (!context || !bridge || context.highlights === "off" || !context.text || targetText.trim() === "") return null
    const verses = wholeVerses(context, ref, type)
    if (!verses) return null
    const bridge1 = bridge1For({ ...context, text: context.text }, cellId, verses.refs, sourceText)
    if (!bridge1) return null
    // Not computed for these texts yet: ask for the chapter.
    if (!bridge2) return { chapter: verses.refs[0].slice(0, verses.refs[0].lastIndexOf(":")), runs: null, tokens: [] }
    const byWord = new Map(mentionsIn(context.index, verses.refs).map((at) => [at.wordId, at]))
    const dotted = alwaysDottedWords(context.text)
    const runs: TintRun[] = targetSpans(bridge1, bridge2, (id) => byWord.has(id), dotted).map((span) => {
      const at = byWord.get(span.wordId)!
      return {
        firstToken: span.firstToken,
        lastToken: span.lastToken,
        entity: at.mention.entity,
        slot: context.highlights === "always" ? threadSlot(context.index, at.ref, at.mention.entity) : null,
        approximate: span.approximate,
      }
    })
    return { chapter: null, runs, tokens: tokenize(targetText) }
  }, [context, bridge, bridge2, cellId, ref, type, sourceText, targetText])

  useEffect(() => {
    if (plan?.chapter && bridge) bridge.request(plan.chapter)
  }, [plan, bridge])

  useEffect(() => {
    const element = root.current
    if (!shown || !context || !element || !plan?.runs || plan.runs.length === 0) return
    return registerTargetTints(cellId, {
      root: element,
      tokens: plan.tokens,
      runs: plan.runs,
      store: context.store,
      always: context.highlights === "always",
    })
  }, [shown, plan, root, cellId, context])
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
