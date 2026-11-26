// Character n-grams: the script-agnostic unit that example retrieval
// (AD-13 branching search) and lexical confidence (AD-14) compare text by.
// Why characters and not words: docs/decisions/0018-retrieval-covers-text-by-character-ngrams.md
//
// A text is normalized (NFC, lowercased, final sigma folded, every run of
// characters that is not a letter, mark or digit collapsed to one space) and
// padded with a space on each side, then read as overlapping windows of
// characters. "In the beginning" → " in", "in ", "n t", " th", … Nothing here
// knows what a word is, so 器皿 inside 並所用的一切銅器皿 matches the same way
// "beginning" inside "In the beginning" does.
//
// The window is three characters, except where it starts on (or just before)
// a Han, Hiragana, Katakana or Hangul character, where it is two. One of those
// characters carries what two or three letters carry elsewhere, and most
// words in them are one or two characters long: a trigram there spans a word
// boundary, so 銅器 would never match inside 一切銅器皿. The choice depends only
// on the characters in the window, so the query and the corpus always cut the
// same text into the same n-grams.
//
// An n-gram is a number, not a string: its UTF-16 code units packed into 48
// bits (a bigram's third unit is 0, which never occurs in normalized text). That keeps the per-request corpus pass to arithmetic and numeric
// Map/Set lookups instead of millions of substring allocations. A character
// outside the BMP is two code units; both sides of a comparison split it the
// same way, so matching is unaffected.

const CONTENT_CHAR = /[\p{L}\p{M}\p{N}]/u
const NON_CONTENT_RUN = /[^\p{L}\p{M}\p{N}]+/gu

/** Lowercase one code point (or a whole string) without the context rule
 *  that turns a word-final Σ into ς: fold ς to σ so a query lowercased one
 *  character at a time and a corpus string lowercased whole agree. */
function lower(s: string): string {
  return s.toLowerCase().replace(/ς/g, "σ")
}

/** Normalized, space-padded form of `text`. Empty string when the text has no
 *  letter, mark or digit. */
export function normalizeForNgrams(text: string): string {
  if (!text) return ""
  const body = lower(text.normalize("NFC")).replace(NON_CONTENT_RUN, " ").trim()
  return body ? ` ${body} ` : ""
}

export interface NormalizedWithOffsets {
  /** Same string `normalizeForNgrams` returns for the input. */
  text: string
  /** For each index of `text`, the half-open range of the NFC input it came
   *  from. A padding or collapsed space maps to an empty range. */
  start: number[]
  end: number[]
  /** The NFC input the offsets point into. */
  source: string
}

/** `normalizeForNgrams`, keeping where each normalized character came from
 *  so a matched span can be quoted back in the person's own text. */
export function normalizeWithOffsets(text: string): NormalizedWithOffsets {
  const source = (text ?? "").normalize("NFC")
  const out: string[] = []
  const start: number[] = []
  const end: number[] = []
  const pushSpace = (at: number) => {
    if (out.length === 0 || out[out.length - 1] === " ") return
    out.push(" ")
    start.push(at)
    end.push(at)
  }
  let offset = 0
  for (const ch of source) {
    const next = offset + ch.length
    if (CONTENT_CHAR.test(ch)) {
      for (const unit of lower(ch)) {
        // `unit` may itself be a surrogate pair; keep code units 1:1 with
        // the normalized string so trigram positions line up.
        for (let i = 0; i < unit.length; i++) {
          out.push(unit[i])
          start.push(offset)
          end.push(next)
        }
      }
    } else {
      pushSpace(offset)
    }
    offset = next
  }
  while (out.length > 0 && out[out.length - 1] === " ") {
    out.pop()
    start.pop()
    end.pop()
  }
  if (out.length === 0) return { text: "", start: [], end: [], source }
  return {
    text: ` ${out.join("")} `,
    start: [0, ...start, source.length],
    end: [0, ...end, source.length],
    source,
  }
}

// Han (incl. extensions A and the compatibility block), Hiragana, Katakana,
// Hangul syllables and jamo. A text with none of them is read as trigrams
// without building a mask.
const DENSE_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u

/** Per code unit of `s`: 1 where it belongs to a dense-script character.
 *  Null when the text has none (the common case, so no mask is built). */
function denseMask(s: string): Uint8Array | null {
  if (!DENSE_SCRIPT.test(s)) return null
  const mask = new Uint8Array(s.length)
  let i = 0
  for (const ch of s) {
    if (DENSE_SCRIPT.test(ch)) for (let k = 0; k < ch.length; k++) mask[i + k] = 1
    i += ch.length
  }
  return mask
}

/**
 * Call `visit(key, start, length)` for every n-gram of a normalized string,
 * in order. `length` is 2 where the window starts on or just before a
 * dense-script character, else 3.
 */
export function forEachNgram(
  s: string,
  visit: (key: number, start: number, length: 2 | 3) => void,
): void {
  const n = s.length
  const dense = denseMask(s)
  for (let i = 0; i + 1 < n; i++) {
    if (dense && (dense[i] || dense[i + 1])) {
      visit(s.charCodeAt(i) * 4294967296 + s.charCodeAt(i + 1) * 65536, i, 2)
    } else if (i + 2 < n) {
      visit(s.charCodeAt(i) * 4294967296 + s.charCodeAt(i + 1) * 65536 + s.charCodeAt(i + 2), i, 3)
    }
  }
}

/** Number of n-grams in a normalized string — BM25's document length. */
export function ngramCount(s: string): number {
  let count = 0
  forEachNgram(s, () => count++)
  return count
}

/** Distinct n-grams of `text` (normalized here). */
export function ngramSet(text: string): Set<number> {
  const out = new Set<number>()
  forEachNgram(normalizeForNgrams(text), (key) => out.add(key))
  return out
}

/** The n-gram back as text, for tests and debugging. */
export function ngramText(key: number): string {
  const a = Math.floor(key / 4294967296)
  const b = Math.floor((key % 4294967296) / 65536)
  const c = key % 65536
  return c === 0 ? String.fromCharCode(a, b) : String.fromCharCode(a, b, c)
}
