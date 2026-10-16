import type { InfractionSpan } from "@/lib/parsers/types"

export const MESSAGE = "Unpaired quotation mark in translation"

/**
 * MQM "Fluency > Punctuation > Unpaired marks", for quotation marks.
 * `unpaired-symbols` covers brackets.
 *
 * Double quotation marks are counted, not paired. Conventions disagree on
 * which mark opens and which closes: German „…“, Swedish ”…”, Danish »…«. But
 * every convention uses two marks per quotation. So an odd count is an open
 * quotation, whatever the style.
 *
 * A quotation that runs across verses leaves an odd count in each cell. So the
 * check compares with the source and stays quiet when the source has the same
 * imbalance. Single marks (‘ ’ ‹ ›) are left out because ’ is also the apostrophe.
 */
const DOUBLE_RE = /["“”„‟«»〝〞＂]/g
const CJK_PAIRS: Array<readonly [open: string, close: string]> = [
  ["「", "」"],
  ["『", "』"],
]

function doubleMarks(text: string): RegExpMatchArray[] {
  return [...text.matchAll(DOUBLE_RE)]
}

function balance(text: string, open: string, close: string): number {
  let n = 0
  for (const ch of text) {
    if (ch === open) n++
    else if (ch === close) n--
  }
  return n
}

export function runCheck(source: string, target: string): InfractionSpan[] | null {
  const spans: InfractionSpan[] = []

  const marks = doubleMarks(target)
  if (marks.length % 2 === 1 && doubleMarks(source).length % 2 === 0) {
    // Which mark lacks its partner is a guess; the last one is where a
    // forgotten closing mark would have gone.
    const last = marks[marks.length - 1]
    spans.push({ side: "target", start: last.index!, end: last.index! + 1, matchedText: last[0] })
  }

  for (const [open, close] of CJK_PAIRS) {
    if (!target.includes(open) && !target.includes(close)) continue
    const diff = balance(target, open, close)
    if (diff === 0 || diff === balance(source, open, close)) continue
    const ch = diff > 0 ? open : close
    const idx = diff > 0 ? target.lastIndexOf(ch) : target.indexOf(ch)
    spans.push({ side: "target", start: idx, end: idx + 1, matchedText: ch })
  }

  return spans.length > 0 ? spans : null
}
