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
// AQU-1700: Hebrew. The pack's OT words are Macula Hebrew morphemes, and a
// Hebrew source cell holds them one of two ways:
//   • a Macula import (src/lib/parsers/macula.ts) keeps one TSV row per
//     morpheme and joins them with spaces, so a prefix (וַ, בְּ, הַ) and a
//     suffix (the ־ִי "me" of בִּי) are tokens of their own and each maps to
//     its own morpheme. An implied article has no letters, so no token;
//   • a source that writes whole words (UHB or WLC through USFM, a pasted
//     text) has one token per surface word, the maqaf (־) separating words
//     like a space: every morpheme of the word shares its token, so the
//     suffix "me" tints its host word בִּי.
// Both are as strict as the Greek: one token per unit, every form equal.
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

/** A run of the cell's text that is one word (or morpheme), normalized. */
interface CellToken {
  start: number
  end: number
  form: string
}

/** The pack words one cell token stands for, and their joined normalized form. */
interface PackUnit {
  ids: BkpWordId[]
  form: string
}

function cellTokens(cellText: string, word: RegExp): CellToken[] {
  const tokens: CellToken[] = []
  for (const match of cellText.matchAll(word)) {
    const form = normalizeOriginalForm(match[0])
    // Punctuation standing on its own ("—", the sof pasuq "׃") is not a word.
    if (form === "") continue
    tokens.push({ start: match.index, end: match.index + match[0].length, form })
  }
  return tokens
}

function matchUnits(tokens: readonly CellToken[], units: readonly PackUnit[]): CellAlignment {
  if (tokens.length !== units.length) return { ok: false, reason: "count-mismatch" }
  const words: AlignedWord[] = []
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].form !== units[i].form) return { ok: false, reason: "form-mismatch" }
    for (const wordId of units[i].ids) words.push({ start: tokens[i].start, end: tokens[i].end, wordId })
  }
  return { ok: true, words }
}

/** A Macula Hebrew morpheme id starts with its surface word's id: "o" + book, chapter, verse and word. */
const HEBREW_MORPHEME_RE = /^o\d{12}/

/** The pack's Hebrew morphemes grouped into surface words, in order; null for Greek words. */
function hebrewSurfaceWords(packWords: readonly { id: BkpWordId; text: string }[]): PackUnit[] | null {
  const units: (PackUnit & { word: string })[] = []
  for (const { id, text } of packWords) {
    if (!HEBREW_MORPHEME_RE.test(id)) return null
    const word = id.slice(0, 12)
    const last = units.at(-1)
    if (last?.word === word) {
      last.ids.push(id)
      last.form += normalizeOriginalForm(text)
    } else {
      units.push({ word, ids: [id], form: normalizeOriginalForm(text) })
    }
  }
  return units
}

/**
 * Map a source cell's words onto the pack's words for its verses, or say why
 * not. A word of a Hebrew source that holds several morphemes appears once
 * per morpheme, all with the same offsets.
 */
export function alignToPackWords(
  cellText: string,
  packWords: readonly { id: BkpWordId; text: string }[] | null,
): CellAlignment {
  if (cellText.includes("\\")) return { ok: false, reason: "markup" }
  if (!packWords || packWords.length === 0) return { ok: false, reason: "no-words" }
  // One token per pack word: Greek, or a Macula Hebrew import's morphemes.
  // A Hebrew implied article has no letters, so it has no token.
  const morphemes = packWords.flatMap(({ id, text }) => {
    const form = normalizeOriginalForm(text)
    return form === "" ? [] : [{ ids: [id], form }]
  })
  const byMorpheme = matchUnits(cellTokens(cellText, /\S+/g), morphemes)
  if (byMorpheme.ok) return byMorpheme
  // Hebrew written as whole words: words split at spaces and at the maqaf.
  const surfaceWords = hebrewSurfaceWords(packWords)
  if (!surfaceWords) return byMorpheme
  const byWord = matchUnits(cellTokens(cellText, /[^\s\u05BE]+/g), surfaceWords)
  if (byWord.ok || byWord.reason === "form-mismatch") return byWord
  return byMorpheme
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
