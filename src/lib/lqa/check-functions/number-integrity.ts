import type { InfractionSpan } from "@/lib/parsers/types"

export const MESSAGE = "Number from source missing in translation"

const NUMBER_RE = /-?\d+(?:[.,]\d+)*/g

function canonicalize(raw: string): string {
  if (raw.startsWith("-")) return "-" + raw.slice(1).replace(/[^0-9]/g, "")
  return raw.replace(/[^0-9]/g, "")
}

export function runCheck(source: string, target: string): InfractionSpan[] | null {
  const sourceMatches = [...source.matchAll(NUMBER_RE)]
  if (sourceMatches.length === 0) return null

  const targetCanonical = new Set(
    [...target.matchAll(NUMBER_RE)].map((m) => canonicalize(m[0])),
  )

  const missing: InfractionSpan[] = []
  for (const m of sourceMatches) {
    if (m.index === undefined) continue
    const canon = canonicalize(m[0])
    if (!targetCanonical.has(canon)) {
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
