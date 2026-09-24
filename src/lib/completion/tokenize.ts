/**
 * The one word tokenizer the completion models share (AQU-462, AQU-1190).
 *
 * Combining marks (`\p{M}`) are part of a word, not separators.
 *
 * Pointed Hebrew carries its vowels as combining marks, so a letters-and-digits
 * class shredded בְּרֵאשִׁית into eleven single-consonant "tokens" — every
 * Hebrew alignment was really a per-consonant alignment, which is noise no
 * matter how good the model is. Greek was unaffected only because its accents
 * arrive precomposed. The same shredding hits any script that points its
 * vowels (Arabic, Devanagari, Thai), so this is a fix for them too.
 *
 * AQU-462 fixed this in `interlinear.ts` alone; `bt-glosser.ts` kept its own
 * copy of the regex and stayed broken until AQU-1190. The two now share this
 * module so they cannot diverge again: alignment and the statistical gloss must
 * agree on where a word ends, since a gloss is read against the alignment the
 * same corpus produced.
 *
 * This module deliberately has no imports — `bt-glosser.ts` is otherwise
 * dependency-free, and pulling in the alignment model just to borrow a regex
 * would undo that.
 */

const TOKEN_RE = /[\p{L}\p{N}\p{M}]+/gu

/** Split a string into lowercase Unicode tokens. */
export function tokenize(s: string): string[] {
  return Array.from(s.matchAll(TOKEN_RE), (m) => m[0].toLowerCase())
}
