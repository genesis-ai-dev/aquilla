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

/** One number as it appears in a cell: its value, canonicalised so ٤٠, ၄၀
 *  and 40 compare equal, and where it sits in the raw string. */
export interface CellNumber {
  value: string
  start: number
  end: number
  raw: string
}

/** Every number in `text`, in order, read the way this check reads them: any
 *  script's decimal digits, the separators above, a leading minus. Shared with
 *  `number-integrity-extra` (AQU-1761), which reads the other direction, so
 *  the two can never disagree about what counts as a number. */
export function readNumbers(text: string): CellNumber[] {
  const out: CellNumber[] = []
  for (const m of text.matchAll(NUMBER_RE)) {
    if (m.index === undefined) continue
    out.push({ value: canonicalize(m[0]), start: m.index, end: m.index + m[0].length, raw: m[0] })
  }
  return out
}

export function runCheck(source: string, target: string): InfractionSpan[] | null {
  const sourceNumbers = readNumbers(source)
  if (sourceNumbers.length === 0) return null

  const targetValues = new Set(readNumbers(target).map((n) => n.value))

  const missing: InfractionSpan[] = []
  for (const n of sourceNumbers) {
    if (!targetValues.has(n.value)) {
      missing.push({ side: "source", start: n.start, end: n.end, matchedText: n.raw })
    }
  }

  return missing.length > 0 ? missing : null
}
