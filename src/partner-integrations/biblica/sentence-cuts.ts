/**
 * Where to cut a Biblica note into sentence-sized cells.
 *
 * A note block is one IDML paragraph — often several sentences of commentary on
 * a passage. Translated as a single cell it is unwieldy: the translator scrolls
 * inside one box, review comments have nowhere specific to land, and no
 * sentence can be marked done on its own. So notes are cut at sentence
 * boundaries and merged back on export (`mergeIdmlSliceTargetHtml`).
 *
 * Rules are deliberately conservative: a missed cut only leaves a larger cell,
 * which is what happens today, while a wrong cut hands the translator half a
 * reference. Where English note prose is ambiguous — abbreviations, initials,
 * chapter numbers — no cut is made.
 *
 * The scan is shared with the Treasure Hunt importer
 * (`./treasure-hunt/sentence-cuts`), which sets its own options because
 * children's material spells references in running prose ("read Genesis 4.")
 * where a study Bible would set them as a citation.
 */

/**
 * Shortest slice worth its own cell, in characters. Splitting "See 2:4." off a
 * paragraph costs a cell and gains nothing, and a note under twice this length
 * stays whole.
 */
const MIN_SLICE_LENGTH = 40

const SENTENCE_TERMINATORS = new Set([".", "!", "?", "\u2026"])

/** Punctuation that may follow a terminator and still belong to that sentence. */
const TRAILING_PUNCTUATION = new Set([
  '"', "'", "\u201d", "\u2019", ")", "]", "}", "\u00bb", "\u203a", ".",
])

/** Punctuation a following sentence may open with. */
const LEADING_PUNCTUATION = new Set([
  '"', "'", "\u201c", "\u2018", "(", "[", "{", "\u00ab", "\u2039", "\u2014", "\u2013",
])

/**
 * Words whose trailing period is not a sentence end. Biblica notes are dense
 * with reference and scholarly abbreviations.
 */
const ABBREVIATIONS: ReadonlySet<string> = new Set([
  "e.g.", "i.e.", "cf.", "etc.", "et al.", "ca.", "c.", "vs.", "viz.",
  "v.", "vv.", "ch.", "chs.", "chap.", "chaps.", "cp.", "ff.", "f.",
  "p.", "pp.", "vol.", "vols.", "no.", "nos.", "lit.", "trans.", "ed.", "eds.",
  "gk.", "heb.", "aram.", "lxx.", "ms.", "mss.", "esv.", "niv.", "kjv.",
  "mr.", "mrs.", "ms.", "dr.", "st.", "sts.", "rev.", "fr.", "jr.", "sr.",
  "a.d.", "b.c.", "a.m.", "p.m.",
])

export interface SentenceCutOptions {
  /** Shortest slice worth its own cell, in characters. */
  readonly minSliceLength?: number
  /** Words whose trailing period is not a sentence end, lower-cased with the period. */
  readonly abbreviations?: ReadonlySet<string>
  /**
   * Whether a period after a bare number ends a sentence. Off for study notes,
   * where "Genesis 3." is a citation; on for prose that says "read Genesis 4.
   * Before that …" and never sets a citation that way.
   */
  readonly numberEndsSentence?: boolean
}

/**
 * Cut points for `text`, as offsets into it.
 *
 * `text` must be the unit's concatenated slot text — the coordinate space
 * `sliceIdmlUnit` cuts in — so that a cut may fall inside a styled run. Each cut
 * lands after the whitespace that follows a sentence's final punctuation, which
 * keeps that space with the sentence it belongs to.
 */
export function sentenceCutPoints(
  text: string,
  options: SentenceCutOptions = {},
): readonly number[] {
  const minSliceLength = options.minSliceLength ?? MIN_SLICE_LENGTH
  const abbreviations = options.abbreviations ?? ABBREVIATIONS
  const numberEndsSentence = options.numberEndsSentence ?? false
  const cuts: number[] = []
  let sliceStart = 0

  for (let index = 0; index < text.length; index += 1) {
    if (!SENTENCE_TERMINATORS.has(text[index])) continue

    let cursor = index + 1
    while (cursor < text.length && TRAILING_PUNCTUATION.has(text[cursor])) cursor += 1
    const punctuationEnd = cursor
    while (cursor < text.length && isWhitespace(text[cursor])) cursor += 1

    // No space after the mark: a decimal, an ellipsis mid-word, a verse letter.
    if (cursor === punctuationEnd) continue
    if (!startsSentence(text, cursor)) continue
    if (
      text[index] === "."
      && !periodEndsSentence(text, index, abbreviations, numberEndsSentence)
    ) {
      continue
    }

    // A tail shorter than one slice can never be cut off, and no later
    // terminator leaves more room, so stop looking.
    if (text.length - cursor < minSliceLength) break
    if (cursor - sliceStart < minSliceLength) continue

    cuts.push(cursor)
    sliceStart = cursor
  }

  return cuts
}

/** Cut points tuned for Biblica study-Bible note prose. */
export function biblicaSentenceCutPoints(text: string): readonly number[] {
  return sentenceCutPoints(text)
}

function isWhitespace(character: string): boolean {
  return /\s/u.test(character)
}

/** True when the text at `index` reads like the start of a new sentence. */
function startsSentence(text: string, index: number): boolean {
  let cursor = index
  while (cursor < text.length && LEADING_PUNCTUATION.has(text[cursor])) cursor += 1
  const character = text[cursor]
  return character !== undefined && (/\p{Lu}/u.test(character) || /\d/u.test(character))
}

/**
 * True when the period at `index` ends a sentence rather than an abbreviation,
 * an initial, or a bare number.
 */
function periodEndsSentence(
  text: string,
  index: number,
  abbreviations: ReadonlySet<string>,
  numberEndsSentence: boolean,
): boolean {
  let start = index
  while (start > 0 && !isWordBreak(text[start - 1])) start -= 1
  const word = text.slice(start, index)
  if (abbreviations.has(`${word.toLowerCase()}.`)) return false
  // "A. B. Smith": a lone capital is an initial.
  if (word.length === 1 && /\p{Lu}/u.test(word)) return false
  if (/^\d+$/.test(word)) {
    // "1." is an enumerator and "Genesis 3." a chapter. Study-note prose cannot
    // tell them apart, so it cuts after neither; prose that only ever numbers a
    // list from the start of the paragraph can cut after the chapter. Either
    // way a reference like "3:16." carries punctuation and can be cut after.
    return numberEndsSentence && start > 0
  }
  return word.length > 0
}

function isWordBreak(character: string): boolean {
  return isWhitespace(character) || LEADING_PUNCTUATION.has(character)
}
