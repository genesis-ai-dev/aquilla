import type { InfractionSpan } from "@/lib/parsers/types"

export const MESSAGE = "Abbreviation from source missing in translation"

// Two or more consecutive ASCII upper-case letters; allow internal periods (U.S.A.) by collapsing.
const ABBREV_RE = /\b[A-Z]{2,}(?:\.[A-Z]+)*\b|\b[A-Z](?:\.[A-Z])+\.?\b/g

function normalize(s: string): string {
  return s.replace(/\./g, "").toUpperCase()
}

export function runCheck(source: string, target: string): InfractionSpan[] | null {
  const sourceMatches = [...source.matchAll(ABBREV_RE)]
  if (sourceMatches.length === 0) return null

  const targetNormalized = new Set(
    [...target.matchAll(ABBREV_RE)].map((m) => normalize(m[0])),
  )

  const missing: InfractionSpan[] = []
  for (const m of sourceMatches) {
    if (m.index === undefined) continue
    if (!targetNormalized.has(normalize(m[0]))) {
      missing.push({
        side: "source",
        start: m.index,
        end: m.index + m[0].length,
        matchedText: m[0],
      })
    }
  }
  return missing.length > 0 ? missing : null
}
