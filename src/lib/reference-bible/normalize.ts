// AQU-1573: word tokens for comparing a draft's quotation with the Bible.
//
// The quote check must not flag spelling the reader does not see as a change
// (Sam, 2026-10-02): vowel marks, tatweel, punctuation and letter case are
// ignored, and so are the hamza/alef spellings Arabic writers vary freely.
// Each token is folded so equal words compare equal:
//   NFKD, then every combining mark removed — this drops tashkeel/harakat,
//   shadda, sukun and superscript alef, and also folds أ إ آ ؤ ئ to their
//   base letters and expands the ﷲ ligature;
//   tatweel removed; ٱ (alef wasla) → ا; ى → ي; ة → ه; Persian ی/ک → ي/ك;
//   Arabic-Indic digits → ASCII; lower case (so the KJV's "LORD" = "Lord").
//
// No path aliases: auth-worker imports this file too (see types.ts).

export interface QuoteToken {
  /** Folded form used for comparison. */
  norm: string
  /** UTF-16 offsets of the original word (end exclusive). */
  start: number
  end: number
}

const WORD = /[\p{L}\p{M}\p{N}ـ]+/gu
const MARKS = /\p{M}/gu

const LETTER_FOLDS: Record<string, string> = {
  "ٱ": "ا", // ٱ alef wasla → ا
  "ى": "ي", // ى alef maksura → ي
  "ة": "ه", // ة ta marbuta → ه
  "ی": "ي", // ی Persian yeh → ي
  "ک": "ك", // ک keheh → ك
}

export function foldWord(word: string): string {
  let s = word.normalize("NFKD").replace(MARKS, "").replace(/ـ/g, "")
  s = s.replace(/[ٱىةیک]/g, (ch) => LETTER_FOLDS[ch] ?? ch)
  s = s.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
  s = s.replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
  return s.toLowerCase()
}

export function quoteTokens(text: string): QuoteToken[] {
  const out: QuoteToken[] = []
  for (const m of text.matchAll(WORD)) {
    const norm = foldWord(m[0])
    if (norm) out.push({ norm, start: m.index, end: m.index + m[0].length })
  }
  return out
}
