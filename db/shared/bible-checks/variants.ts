// Textual variants for S6 and S7 (AQU-1697; design doc §7.6).
//
// S6: whole verses the critical text leaves out. NA28 and SBLGNT print none
// of these; older translations (KJV, and the WEB that follows the Majority
// Text) keep them. The list is NA28's omissions. Cross-checked on 2026-10-06
// with the Macula Greek (SBLGNT) verse set in the pack (BKP 1.1.0): every
// verse below is absent from it except ROM 16:24, which Macula numbers for
// the closing grace ("Ἡ χάρις τοῦ κυρίου ἡμῶν…") that NA28 leaves out. The
// eval script (scripts/bible-checks-eval.ts) repeats that cross-check
// against any pack it reads.
//
// S7: passages the critical text prints but marks as doubtful, in double
// brackets: the woman taken in adultery (JHN 7:53–8:11) and the longer ending
// of Mark (MRK 16:9–20). Both are in the pack. Mark's shorter ending has no
// verse number of its own (SBLGNT folds it into MRK 16:8), so no cell can be
// matched to it; it is not checked.
//
// Relative imports only, no DOM: shared with the workers.

import type { VariantFact } from './types'

export const ABSENT_VERSES: readonly string[] = [
  'MAT 17:21',
  'MAT 18:11',
  'MAT 23:14',
  'MRK 7:16',
  'MRK 9:44',
  'MRK 9:46',
  'MRK 11:26',
  'MRK 15:28',
  'LUK 17:36',
  'LUK 23:17',
  'JHN 5:4',
  'ACT 8:37',
  'ACT 15:34',
  'ACT 24:7',
  'ACT 28:29',
  'ROM 16:24',
]

/** Disputed passages, each verse in reading order. */
export const DISPUTED_PASSAGES: readonly { label: string; verses: readonly string[] }[] = [
  { label: 'JHN 7:53–8:11', verses: ['JHN 7:53', ...Array.from({ length: 11 }, (_, i) => `JHN 8:${i + 1}`)] },
  { label: 'MRK 16:9–20', verses: Array.from({ length: 12 }, (_, i) => `MRK 16:${i + 9}`) },
]

const ABSENT = new Set(ABSENT_VERSES)

/** Every verse S6 or S7 has a policy for. */
export function isVariantVerse(ref: string): boolean {
  return ABSENT.has(ref) || DISPUTED_PASSAGES.some((p) => p.verses.includes(ref))
}

/**
 * What the cell's verses mean for the variant policy, or null when none of
 * them is a variant verse. A cell that also holds other verses (a bridge
 * such as MAT 17:20–21) is `partial`: only part of its text is the variant.
 */
export function cellVariant(refs: readonly string[]): VariantFact | null {
  const absent = refs.filter((ref) => ABSENT.has(ref))
  if (absent.length > 0) {
    return { kind: 'absent', refs: absent, passage: absent.join(', '), opens: true, closes: true, partial: absent.length < refs.length }
  }
  for (const passage of DISPUTED_PASSAGES) {
    const inside = refs.filter((ref) => passage.verses.includes(ref))
    if (inside.length === 0) continue
    return {
      kind: 'disputed',
      refs: inside,
      passage: passage.label,
      opens: inside.includes(passage.verses[0]),
      closes: inside.includes(passage.verses[passage.verses.length - 1]),
      partial: inside.length < refs.length,
    }
  }
  return null
}
