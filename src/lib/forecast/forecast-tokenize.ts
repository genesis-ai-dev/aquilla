/**
 * forecast-tokenize.ts — the one word segmenter every part of BIA forecasting
 * uses (index, engine, source lexicon, thesaurus, eval), built to make no
 * assumption about the language:
 *
 *   - NFC first, so a word typed with decomposed marks (Devanagari, Hebrew
 *     niqqud, Vietnamese) is the same key as its precomposed spelling.
 *   - Word boundaries from `Intl.Segmenter` (UAX #29 plus ICU's dictionaries),
 *     so Thai, Lao, Khmer, Burmese, Chinese and Japanese — written without
 *     spaces — split into words instead of one sentence-long token. Where the
 *     runtime has no Segmenter, a Unicode-category regex is the fallback.
 *   - Letters, marks and digits by Unicode category (\p{L}\p{M}\p{N}), plus the
 *     zero-width (non-)joiners Persian and Indic spelling put inside words.
 *   - Apostrophes: between letters they are part of the word (UAX #29 already
 *     keeps "b'i", "God’s"); a straight ASCII apostrophe at the START or END
 *     of a word is also kept, because many orthographies write the glottal
 *     stop with it (K'iche' "xuquje'", Hawaiian, Tok Pisin loanwords). The
 *     typographic ’ at a word edge is left as punctuation: it is usually a
 *     closing quote.
 *   - Keys are case-folded locale-independently (`toLowerCase()` uses the
 *     Unicode default mapping; final sigma ς folds to σ). Scripts without
 *     case are untouched. The original spelling is kept as `surface`.
 *   - No direction logic: text is handled in logical order, so right-to-left
 *     Hebrew and Arabic need nothing special here.
 */

export interface WordToken {
  /** The word as written (NFC). */
  surface: string
  /** Case-folded comparison key. */
  key: string
  /** Offsets into the NFC-normalised input. */
  start: number
  end: number
}

const WORD_CLASS = "\\p{L}\\p{M}\\p{N}\\u200C\\u200D"
const WORD_CHAR = new RegExp(`[${WORD_CLASS}]`, "u")
const FALLBACK_RE = new RegExp(
  `'?[${WORD_CLASS}]+(?:['’ʼ][${WORD_CLASS}]+)*'?`,
  "gu",
)

/**
 * Scripts written without spaces between words. A word from one of these is
 * joined to its neighbour with no space, and a caret right after one may be
 * at a word boundary even though no space was typed.
 */
const SPACELESS = /[\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u

type Segmenter = { segment: (text: string) => Iterable<{ segment: string; index: number; isWordLike?: boolean }> }

function makeSegmenter(granularity: "word" | "grapheme"): Segmenter | null {
  const ctor = (Intl as unknown as { Segmenter?: new (locale: undefined, opts: { granularity: string }) => Segmenter }).Segmenter
  return ctor ? new ctor(undefined, { granularity }) : null
}

let wordSegmenter: Segmenter | null | undefined
let graphemeSegmenter: Segmenter | null | undefined

/** Test hook: force the regex fallback (null) or restore the default (undefined). */
export function setSegmenterForTests(segmenter: Segmenter | null | undefined): void {
  wordSegmenter = segmenter
}

export function fold(word: string): string {
  return word.toLowerCase().replace(/ς/g, "σ")
}

export function isWordChar(char: string | undefined): boolean {
  return char !== undefined && WORD_CHAR.test(char)
}

export function isSpaceless(char: string | undefined): boolean {
  return char !== undefined && SPACELESS.test(char)
}

/** Space to put between `before` and `after` when joining two words. */
export function joiner(before: string, after: string): string {
  return isSpaceless(before.at(-1)) || isSpaceless(after[0]) ? "" : " "
}

/** Words of `text` with their spelling, key and offsets (in NFC text). */
export function segmentWords(input: string): WordToken[] {
  const text = input.normalize("NFC")
  if (wordSegmenter === undefined) wordSegmenter = makeSegmenter("word")
  const out: WordToken[] = []
  const push = (start: number, end: number) => {
    const surface = text.slice(start, end)
    out.push({ surface, key: fold(surface), start, end })
  }
  if (!wordSegmenter) {
    for (const m of text.matchAll(FALLBACK_RE)) push(m.index ?? 0, (m.index ?? 0) + m[0].length)
    return out
  }
  for (const { segment, index, isWordLike } of wordSegmenter.segment(text)) {
    if (!isWordLike && !WORD_CHAR.test(segment)) continue
    let start = index
    let end = index + segment.length
    // A straight apostrophe glued to the word's edge is part of it.
    if (text[start - 1] === "'" && !isWordChar(text[start - 2])) start--
    if (text[end] === "'" && !isWordChar(text[end + 1])) end++
    const last = out.at(-1)
    if (last && last.end > start) start = last.end
    if (end > start) push(start, end)
  }
  return out
}

/** Case-folded word keys of `text`. */
export function wordKeys(text: string): string[] {
  return segmentWords(text).map((w) => w.key)
}

/** True when `word` is exactly one word with nothing else around it. */
export function isSingleWord(word: string): boolean {
  const words = segmentWords(word)
  return words.length === 1 && words[0].surface === word.normalize("NFC")
}

const graphemeCache = new Map<string, string[]>()

/** The word's user-perceived characters (a consonant + its vowel signs is one). */
export function graphemes(word: string): string[] {
  const cached = graphemeCache.get(word)
  if (cached) return cached
  if (graphemeSegmenter === undefined) graphemeSegmenter = makeSegmenter("grapheme")
  const out = graphemeSegmenter
    ? Array.from(graphemeSegmenter.segment(word), (s) => s.segment)
    : Array.from(word)
  if (graphemeCache.size > 50_000) graphemeCache.clear()
  graphemeCache.set(word, out)
  return out
}
