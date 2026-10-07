import type { InfractionSpan } from "@/lib/parsers/types"

export const MESSAGE = "Number from source missing in translation"

// AQU-1667: a translation may write its numbers in its own script's digits:
// Arabic-Indic ٤٠, Persian ۴۰, Burmese ၄၀, Thai ๔๐, Devanagari ४०, fullwidth
// ４０, and so on. JS `\d` is ASCII-only, which made all of those invisible and
// flagged the source's "40" as missing. So a digit here is ANY Unicode decimal
// digit (General_Category Nd): every script Unicode gives decimal digits, with
// no per-script list to keep up (Sam: "as many scripts covered as possible").
// Spans are taken from the raw string, so source underline positions never
// move, including for digits outside the BMP, which take two UTF-16 units.
const DIGIT = "\\p{Nd}"
// Between digit groups: "." and "," as before, plus their Arabic forms, the
// decimal separator ٫ (U+066B) and the thousands separator ٬ (U+066C). The
// Arabic comma "،" (U+060C) is a list separator, never part of a number.
const GROUP_SEPARATOR = "[.,\\u066B\\u066C]"
const NUMBER_RE = new RegExp(`-?${DIGIT}+(?:${GROUP_SEPARATOR}${DIGIT}+)*`, "gu")

const ANY_DIGIT_RE = /\p{Nd}/gu
const IS_DIGIT = /^\p{Nd}$/u

/** A decimal digit's value, 0–9, in any script.
 *
 *  Unicode's stability policy keeps every script's decimal digits in one run of
 *  ten consecutive code points, 0 first. Some runs sit back to back (the five
 *  mathematical digit styles fill U+1D7CE–1D7FF), so the value is the distance
 *  from the start of the run, mod 10. Runs are at most 50 long, and each code
 *  point is worked out once. */
const digitValues = new Map<number, number>()
function digitValue(cp: number): number {
  const known = digitValues.get(cp)
  if (known !== undefined) return known
  let start = cp
  while (start > 0 && IS_DIGIT.test(String.fromCodePoint(start - 1))) start--
  const value = (cp - start) % 10
  digitValues.set(cp, value)
  return value
}

/** ٤, ۴, ၄, ๔ and 4 all become "4". */
function toWesternDigit(ch: string): string {
  return String(digitValue(ch.codePointAt(0)!))
}

function canonicalize(raw: string): string {
  const western = raw.replace(ANY_DIGIT_RE, toWesternDigit)
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
