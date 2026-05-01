import type { InfractionSpan } from "@/lib/parsers/types"

export const MESSAGE = "Translation is identical to the source"

const MIN_LENGTH = 4

export function runCheck(source: string, target: string): InfractionSpan[] | null {
  const s = source.trim()
  const t = target.trim()
  if (s.length < MIN_LENGTH || t.length < MIN_LENGTH) return null
  if (s !== t) return null
  return [{ side: "target", start: 0, end: target.length, matchedText: target }]
}
