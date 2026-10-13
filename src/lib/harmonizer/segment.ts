// Word spans for pointing at a phrase in a target text, in any script.
//
// Checks that need to underline a referring expression cannot assume spaces
// between words (Thai, Chinese, Japanese) or Latin letters. Intl.Segmenter
// knows word boundaries per script and runs in browsers, Node and Workers; the
// regex fallback covers a runtime without it.

export interface WordSpan {
  start: number
  end: number
  text: string
}

const FALLBACK = /[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N}'’‑-]*/gu

export function wordSpans(text: string, limit = Infinity): WordSpan[] {
  const out: WordSpan[] = []
  if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
    for (const seg of new Intl.Segmenter(undefined, { granularity: "word" }).segment(text)) {
      if (!seg.isWordLike) continue
      out.push({ start: seg.index, end: seg.index + seg.segment.length, text: seg.segment })
      if (out.length >= limit) break
    }
    return out
  }
  for (const m of text.matchAll(FALLBACK)) {
    const start = m.index ?? 0
    out.push({ start, end: start + m[0].length, text: m[0] })
    if (out.length >= limit) break
  }
  return out
}
