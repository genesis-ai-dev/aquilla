import type { InfractionSpan } from "@/lib/parsers/types"

export const MESSAGE = "Word repeated in translation"

const TOKEN_RE = /\p{L}+/giu

interface Repeat { start: number; end: number; matchedText: string }

function findRepeats(text: string): Repeat[] {
  const tokens = [...text.matchAll(TOKEN_RE)]
  const out: Repeat[] = []
  for (let i = 1; i < tokens.length; i++) {
    const a = tokens[i - 1]
    const b = tokens[i]
    if (a.index === undefined || b.index === undefined) continue
    if (a[0].toLowerCase() !== b[0].toLowerCase()) continue
    // Only count tokens separated by pure whitespace (no other tokens between).
    const between = text.slice(a.index + a[0].length, b.index)
    if (!/^\s+$/.test(between)) continue
    out.push({
      start: a.index,
      end: b.index + b[0].length,
      matchedText: text.slice(a.index, b.index + b[0].length),
    })
  }
  return out
}

export function runCheck(source: string, target: string): InfractionSpan[] | null {
  const targetHits = findRepeats(target)
  if (targetHits.length === 0) return null

  // Suppress when source has at least as many repetitions — likely intentional.
  if (findRepeats(source).length >= targetHits.length) return null

  return targetHits.map((h) => ({
    side: "target" as const,
    start: h.start,
    end: h.end,
    matchedText: h.matchedText,
  }))
}
