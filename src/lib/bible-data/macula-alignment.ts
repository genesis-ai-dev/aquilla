// Who's Who, word tints on the source text (AQU-1689).
//
// The pack knows its facts word by word, by Macula word id. A project's source
// cell can carry them only when its words ARE the pack's words: a Greek or
// Hebrew source imported from Macula (`macula-bible`), or another edition of
// the same text that happens to match. This module decides that, per cell, and
// maps each source word to its Macula word id.
//
// The test is strict on purpose: the cell must have exactly as many words as
// the verse (or verses, for a bridge) and every word's normalized form must be
// the Macula word's. One mismatch and the cell gets no tints at all, never
// tints on the wrong words. A gateway-language source (an English or
// Indonesian Bible) never matches; its word tints come through the stored
// word alignment instead (Bridge 1: source-alignment.ts, AQU-1694), and
// without one the verse-level features still work.
//
// Pure. Spec: 04-features/bible-knowledge-layer.md, Edge cases ("The source
// text is not Greek or Hebrew").

import type { BkpRef, BkpTextLayer, BkpWordId } from "./pack-types"

/**
 * Why a cell has no word tints:
 *   markup         — the text holds USFM markers, which this mapping does not read;
 *   no-words       — the pack has no words for one of the cell's verses;
 *   count-mismatch — the cell has more or fewer words than the verse;
 *   form-mismatch  — the counts agree but a word differs (another edition, or
 *                    another language).
 */
export type AlignmentFailure = "markup" | "no-words" | "count-mismatch" | "form-mismatch"

/** One source word, by its UTF-16 offsets in the cell text, and the Macula word it is. */
export interface AlignedWord {
  start: number
  end: number
  wordId: BkpWordId
}

export type CellAlignment =
  | { ok: true; words: readonly AlignedWord[] }
  | { ok: false; reason: AlignmentFailure }

/**
 * A word form without accents, breathings, vowel points or punctuation, in
 * lower case, with final sigma folded: "Αὐτὸν," and "αὐτόν" compare equal.
 */
export function normalizeOriginalForm(form: string): string {
  return form
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/ς/g, "σ")
    .replace(/[^\p{L}\p{N}]/gu, "")
}

/** The pack's words for a cell's verses, in order, or null when a verse has none. */
export function packWordsFor(
  text: BkpTextLayer,
  refs: readonly BkpRef[],
): { id: BkpWordId; text: string }[] | null {
  const out: { id: BkpWordId; text: string }[] = []
  for (const ref of refs) {
    const ids = Object.hasOwn(text.verses, ref) ? text.verses[ref] : undefined
    if (!ids || ids.length === 0) return null
    for (const id of ids) {
      const word = Object.hasOwn(text.words, id) ? text.words[id] : undefined
      if (!word) return null
      out.push({ id, text: word.text })
    }
  }
  return out
}

/** Map a source cell's words onto the pack's words for its verses, or say why not. */
export function alignToPackWords(
  cellText: string,
  packWords: readonly { id: BkpWordId; text: string }[] | null,
): CellAlignment {
  if (cellText.includes("\\")) return { ok: false, reason: "markup" }
  if (!packWords || packWords.length === 0) return { ok: false, reason: "no-words" }
  const tokens: { start: number; end: number; form: string }[] = []
  for (const match of cellText.matchAll(/\S+/g)) {
    const form = normalizeOriginalForm(match[0])
    // Punctuation standing on its own ("—") is not a word.
    if (form === "") continue
    tokens.push({ start: match.index, end: match.index + match[0].length, form })
  }
  if (tokens.length !== packWords.length) return { ok: false, reason: "count-mismatch" }
  const words: AlignedWord[] = []
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].form !== normalizeOriginalForm(packWords[i].text)) return { ok: false, reason: "form-mismatch" }
    words.push({ start: tokens[i].start, end: tokens[i].end, wordId: packWords[i].id })
  }
  return { ok: true, words }
}

/** Language codes of the texts the pack is built on: Koine Greek and Biblical Hebrew (and their loose names). */
const ORIGINAL_LANGUAGE_TAGS = new Set(["grc", "ell", "hbo", "heb"])

/**
 * The project's source is the Greek or Hebrew text itself, by its language
 * code (after `normalizeLanguageTag`). Only a hint for the Who's Who panel's
 * note; the per-cell check above is what turns tints on.
 */
export function isOriginalLanguageTag(normalizedTag: string): boolean {
  return ORIGINAL_LANGUAGE_TAGS.has(normalizedTag)
}
