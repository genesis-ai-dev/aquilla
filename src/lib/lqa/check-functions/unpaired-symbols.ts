import type { InfractionSpan } from "@/lib/parsers/types"

export const MESSAGE = "Unpaired bracket/parenthesis/brace in translation"

const PAIRS: Array<readonly [open: string, close: string]> = [
  ["(", ")"],
  ["[", "]"],
  ["{", "}"],
]

interface Imbalance { open: number; close: number }

function tally(text: string): Map<string, Imbalance> {
  const m = new Map<string, Imbalance>()
  for (const [o, c] of PAIRS) m.set(o + c, { open: 0, close: 0 })
  for (const ch of text) {
    for (const [o, c] of PAIRS) {
      if (ch === o) m.get(o + c)!.open++
      else if (ch === c) m.get(o + c)!.close++
    }
  }
  return m
}

export function runCheck(source: string, target: string): InfractionSpan[] | null {
  const targetTally = tally(target)
  const sourceTally = tally(source)

  const spans: InfractionSpan[] = []
  for (const [pair, t] of targetTally) {
    if (t.open === t.close) continue
    const s = sourceTally.get(pair)!
    const targetDiff = t.open - t.close
    const sourceDiff = s.open - s.close
    if (targetDiff === sourceDiff) continue

    const offendingChar = targetDiff > 0 ? pair[0] : pair[1]
    const idx = target.indexOf(offendingChar)
    spans.push({
      side: "target",
      start: idx >= 0 ? idx : 0,
      end: idx >= 0 ? idx + 1 : 0,
      matchedText: offendingChar,
    })
  }
  return spans.length > 0 ? spans : null
}
