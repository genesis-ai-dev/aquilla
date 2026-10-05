import type { InfractionSpan } from "@/lib/parsers/types"

export const MESSAGE = "Number from source missing in translation"

// AQU-1667: Arabic, Persian and Urdu translations write numbers in their own
// digits, so a digit here is any of Western 0–9, Arabic-Indic ٠–٩
// (U+0660–0669) or Eastern Arabic-Indic / Persian ۰–۹ (U+06F0–06F9). JS `\d`
// is ASCII-only, which made "٤٠" invisible and flagged the source's "40" as
// missing. Every one of these is a single UTF-16 unit, and spans are taken
// from the raw string, so source underline positions never move.
const DIGIT = "[0-9\\u0660-\\u0669\\u06F0-\\u06F9]"
// Between digit groups: "." and "," as before, plus their Arabic forms, the
// decimal separator ٫ (U+066B) and the thousands separator ٬ (U+066C). The
// Arabic comma "،" (U+060C) is a list separator, never part of a number.
const GROUP_SEPARATOR = "[.,\\u066B\\u066C]"
const NUMBER_RE = new RegExp(`-?${DIGIT}+(?:${GROUP_SEPARATOR}${DIGIT}+)*`, "g")

const NATIVE_DIGIT_RE = /[٠-٩۰-۹]/g

/** ٤ (U+0664) and ۴ (U+06F4) both become "4"; anything else is untouched. */
function toWesternDigit(ch: string): string {
  const code = ch.charCodeAt(0)
  return String(code >= 0x06f0 ? code - 0x06f0 : code - 0x0660)
}

function canonicalize(raw: string): string {
  const western = raw.replace(NATIVE_DIGIT_RE, toWesternDigit)
  if (western.startsWith("-")) return "-" + western.slice(1).replace(/[^0-9]/g, "")
  return western.replace(/[^0-9]/g, "")
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
