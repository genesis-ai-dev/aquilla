import type { InfractionSpan } from "@/lib/parsers/types"

export const MESSAGE = "Translation is much shorter or longer than the source"

/**
 * MQM "Accuracy > Omission / Addition", as a cheap length signal. A
 * translation far shorter than its source has often lost a clause, and one
 * far longer has often gained one. Code can't see meaning, so this check only
 * points at the cell.
 *
 * Off by default. Normal length differs a lot between language pairs, and
 * CJK scripts pack a word into one or two characters. Only letters and
 * digits count, so markup spacing and punctuation don't move the ratio.
 * Short sources are skipped, because a few characters make a ratio noisy.
 */
const COUNTED_RE = /[\p{L}\p{N}]/gu
const MIN_SOURCE_CHARS = 20
const MIN_RATIO = 0.4
const MAX_RATIO = 2.5

function counted(text: string): number {
  return text.match(COUNTED_RE)?.length ?? 0
}

export function runCheck(source: string, target: string): InfractionSpan[] | null {
  const s = counted(source)
  if (s < MIN_SOURCE_CHARS) return null
  const ratio = counted(target) / s
  if (ratio >= MIN_RATIO && ratio <= MAX_RATIO) return null
  return [{ side: "target", start: 0, end: target.length, matchedText: target }]
}
