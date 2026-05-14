import type { InfractionSpan } from "@/lib/parsers/types"

export const MESSAGE = "Extra whitespace in translation"

const DOUBLE_SPACE_RE = / {2,}/g
const LEADING_RE = /^\s+/
const TRAILING_RE = /\s+$/

function findAll(text: string): { start: number; end: number; matchedText: string }[] {
  const out: { start: number; end: number; matchedText: string }[] = []
  for (const m of text.matchAll(DOUBLE_SPACE_RE)) {
    if (m.index === undefined) continue
    out.push({ start: m.index, end: m.index + m[0].length, matchedText: m[0] })
  }
  const lead = text.match(LEADING_RE)
  if (lead) out.unshift({ start: 0, end: lead[0].length, matchedText: lead[0] })
  const trail = text.match(TRAILING_RE)
  if (trail) {
    const start = text.length - trail[0].length
    out.push({ start, end: text.length, matchedText: trail[0] })
  }
  return out
}

export function runCheck(source: string, target: string): InfractionSpan[] | null {
  const targetHits = findAll(target)
  if (targetHits.length === 0) return null

  const sourceWidths = findAll(source).map((h) => h.matchedText.length).sort()
  const targetWidths = targetHits.map((h) => h.matchedText.length).sort()
  if (sourceWidths.length === targetWidths.length
      && sourceWidths.every((w, i) => w === targetWidths[i])) {
    return null
  }

  return targetHits.map((h) => ({
    side: "target" as const,
    start: h.start,
    end: h.end,
    matchedText: h.matchedText,
  }))
}
