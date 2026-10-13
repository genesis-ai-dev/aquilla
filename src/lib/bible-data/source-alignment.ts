// Bridge 1 (AQU-1694): the pack's Greek words → a project's source text.
//
// Who's Who knows its facts word by word, by Macula word id. A project whose
// source is a gateway-language Bible (English, French, Indonesian …) has no
// Macula ids, so its words get them through a statistical alignment trained
// on the book itself: each source cell paired with the pack's Greek words for
// its verses.
//
// The recipe is the one scripts/bridge-align-eval.ts measured best on John
// against Clear's manual SBLGNT→BSB alignment (see that script's header):
//   • Greek words as their surface form when the form occurs at least
//     SURFACE_MIN_COUNT times in the book, else as their lemma. Pronouns keep
//     their case and person ("αὐτῇ", "μοι"), and a rare inflected verb still
//     shares statistics with its other forms;
//   • word-align.ts (IBM-1 both ways, grow-diag-final-and);
//   • one Who's Who constraint: a proper noun the statistics left without a
//     capitalized partner gets the free capitalized source word spelled like
//     it (name-match.ts).
//
// Only cells that are whole verses (or bridges of whole verses) take part: a
// cell holding part of a verse has no Greek words of its own. Pure.

import { tokenSpans, tokenize, type TokenSpan } from "@/lib/completion/tokenize"
import { contentHash } from "@/lib/dcs/content-hash"
import type { BkpRef, BkpTextLayer, BkpWord, BkpWordId } from "./pack-types"
import { isCapitalized, nameSimilarity } from "./name-match"
import { alignWords, trainWordAlignModel, type AlignLink, type WordAlignOptions } from "./word-align"

/**
 * Stored with every row, so a later change of recipe can tell its rows apart.
 * Another recipe (an imported manual alignment, or an LLM aligner such as
 * `text-align`) would write the same rows under its own method; Who's Who
 * reads every method alike, by confidence and training size.
 */
export const SOURCE_ALIGNMENT_METHOD = "ibm1-gdfa-names/1"

/** A Greek form seen fewer times than this in the book is aligned by its lemma. */
export const SURFACE_MIN_COUNT = 10

/** A capitalized source word at least this much like a Greek name may be linked to it. */
export const NAME_MATCH_MIN = 0.75

/** A link this confident "holds" its source word: the name constraint leaves it alone. */
const HELD_CONF = 0.5

/** A source cell that covers whole verses. */
export interface SourceCellInput {
  cellId: string
  refs: readonly BkpRef[]
  /** The cell's text, as stored (cells.value). */
  text: string
}

/** One Greek word linked to one token of the source cell (`tokenize` order). */
export interface SourceWordLink {
  wordId: BkpWordId
  token: number
  conf: number
}

export interface SourceCellAlignment {
  cellId: string
  /** contentHash of the text the links were computed on (cells.content_hash). */
  sourceHash: string
  links: SourceWordLink[]
}

export interface SourceBookAlignment {
  /** The verse cells the model trained on (see SOLID_MIN_PAIRS in bridge-compose.ts). */
  trainedPairs: number
  cells: SourceCellAlignment[]
}

interface PreparedCell {
  cellId: string
  text: string
  ids: BkpWordId[]
  words: BkpWord[]
  spans: TokenSpan[]
}

/** The pack's words for a cell's verses, or null when one of them has none. */
function packWords(text: BkpTextLayer, refs: readonly BkpRef[]): { ids: BkpWordId[]; words: BkpWord[] } | null {
  const ids: BkpWordId[] = []
  const words: BkpWord[] = []
  for (const ref of refs) {
    const verse = Object.hasOwn(text.verses, ref) ? text.verses[ref] : undefined
    if (!verse || verse.length === 0) return null
    for (const id of verse) {
      const word = Object.hasOwn(text.words, id) ? text.words[id] : undefined
      if (!word) return null
      ids.push(id)
      words.push(word)
    }
  }
  return { ids, words }
}

const surfaceOf = (word: BkpWord): string => tokenize(word.text).join("") || tokenize(word.lemma).join("")

/** The Greek side as the model sees it: frequent surface forms, else "lemma:" + lemma. */
export function greekTokens(words: readonly BkpWord[], surfaceCounts: ReadonlyMap<string, number>): string[] {
  return words.map((word) => {
    const surface = surfaceOf(word)
    return (surfaceCounts.get(surface) ?? 0) >= SURFACE_MIN_COUNT ? surface : `lemma:${tokenize(word.lemma).join("")}`
  })
}

/** Add name links (see the header). Returns a new list; existing links are kept as they are. */
export function addNameLinks(words: readonly BkpWord[], spans: readonly TokenSpan[], links: readonly AlignLink[]): AlignLink[] {
  const held = new Map<number, number>()
  for (const link of links) held.set(link.tgt, Math.max(held.get(link.tgt) ?? 0, link.conf))
  const out = [...links]
  words.forEach((word, i) => {
    if (word.class !== "noun" || word.type !== "proper") return
    const named = out.some(
      (link) => link.src === i && isCapitalized(spans[link.tgt].raw) && nameSimilarity(word.lemma, spans[link.tgt].raw) >= 0.5,
    )
    if (named) return
    const expected = ((i + 0.5) / words.length) * spans.length
    let best = -1
    let bestSimilarity = NAME_MATCH_MIN
    spans.forEach((span, j) => {
      if (!isCapitalized(span.raw) || (held.get(j) ?? 0) >= HELD_CONF) return
      const similarity = nameSimilarity(word.lemma, span.raw)
      if (similarity < bestSimilarity) return
      if (best < 0 || similarity > bestSimilarity || Math.abs(j - expected) < Math.abs(best - expected)) {
        best = j
        bestSimilarity = similarity
      }
    })
    if (best < 0) return
    out.push({ src: i, tgt: best, conf: bestSimilarity })
    held.set(best, bestSimilarity)
  })
  return out.sort((a, b) => a.src - b.src || a.tgt - b.tgt)
}

/**
 * Align a book's source cells to the pack. Cells whose verses the pack lacks,
 * or with no words, are left out. Returns null when `options.shouldStop` stopped it.
 */
export function alignSourceBook(
  text: BkpTextLayer,
  cells: readonly SourceCellInput[],
  options: WordAlignOptions = {},
): SourceBookAlignment | null {
  const prepared: PreparedCell[] = []
  for (const cell of cells) {
    const greek = packWords(text, cell.refs)
    const spans = tokenSpans(cell.text)
    if (!greek || spans.length === 0) continue
    prepared.push({ cellId: cell.cellId, text: cell.text, ids: greek.ids, words: greek.words, spans })
  }
  const surfaceCounts = new Map<string, number>()
  for (const cell of prepared) {
    for (const word of cell.words) surfaceCounts.set(surfaceOf(word), (surfaceCounts.get(surfaceOf(word)) ?? 0) + 1)
  }
  const sources = prepared.map((cell) => greekTokens(cell.words, surfaceCounts))
  const model = trainWordAlignModel(
    prepared.map((cell, k) => ({ src: sources[k], tgt: cell.spans.map((span) => span.token) })),
    options,
  )
  if (!model) return null
  const aligned = prepared.map((cell, k) => {
    const links = addNameLinks(
      cell.words,
      cell.spans,
      alignWords(model, sources[k], cell.spans.map((span) => span.token)),
    )
    return {
      cellId: cell.cellId,
      sourceHash: contentHash(cell.text),
      links: links.map((link) => ({ wordId: cell.ids[link.src], token: link.tgt, conf: link.conf })),
    }
  })
  return { trainedPairs: prepared.length, cells: aligned }
}
