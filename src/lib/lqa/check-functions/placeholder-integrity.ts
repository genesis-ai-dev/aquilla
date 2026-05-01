import type { InfractionSpan } from "@/lib/parsers/types"

export const MESSAGE = "Placeholder missing in translation"

// Order matters: longer patterns first so e.g. %1$s isn't shadowed by %s.
// Keep these alternations narrow — broad patterns produce false positives.
const PLACEHOLDER_RE = new RegExp(
  [
    "%\\d+\\$[sdif]",     // %1$s, %2$d
    "%[sdif]",            // %s, %d, %i, %f
    "\\\\[nrt]",          // \n \r \t
    "&[a-z]+;",           // &amp; &nbsp;
    "</?[a-zA-Z][^>]*>",  // <tag> </tag> <tag attr="x">
    "\\{[^}\\s]+\\}",     // {name}
  ].join("|"),
  "g",
)

export function extractPlaceholders(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(PLACEHOLDER_RE)) out.push(m[0])
  return out
}

export function runCheck(source: string, target: string): InfractionSpan[] | null {
  const sourcePlaceholders = extractPlaceholders(source)
  if (sourcePlaceholders.length === 0) return null

  const seen = new Set(extractPlaceholders(target))
  const missing: InfractionSpan[] = []

  for (const m of source.matchAll(PLACEHOLDER_RE)) {
    if (m.index === undefined) continue
    if (!seen.has(m[0])) {
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
