import type { InfractionSpan } from "@/lib/parsers/types"
import type { NumberFormatConventions } from "../../../../db/shared/number-format"
import { WESTERN_DIGITS } from "../../../../db/shared/number-format"
import type { BuiltinCheckRunContext } from "../builtin-run-context"
import { readNumbers } from "./number-integrity"
import { scanReferences, type ScannedReference } from "./scripture-reference"

export const MESSAGE = "Number is not written the way the target language writes numbers"

// AQU-2430: the number-format half of AQU-1735's Paratext parity, which the
// `scripture-reference` check that shipped for it left out.
//
// `number-integrity` asks whether the source's numbers SURVIVED into the
// translation — it canonicalises "٤٠", "၄၀" and "40" to one value on purpose,
// so it is blind to HOW a number is written. This check asks the other
// question: is the number written the way the target language writes numbers?
// Two rules, both judged against `context.numberFormat` (CLDR, or the
// project's Language profile slot — db/shared/number-format.ts):
//
//   1. SEPARATORS. A number whose separators cannot be read as the language's
//      own is flagged: "3,5" in an English lane (English groups with "," and
//      only in threes, and marks a fraction with "."), "1.234,56" in English,
//      "1,234.56" in German.
//   2. DIGITS. A number written in a digit set the language does not use:
//      Devanagari "४०" in an Arabic lane. Western digits are accepted
//      everywhere (WESTERN_DIGITS), so a Burmese lane writing "40" is fine
//      while "٤٠" is not.
//
// WHY A SEPARATOR IS READ BY ROLE, LEFT TO RIGHT, AND NOT BY POSITION ALONE:
// "1,234" is a well-formed French number (one point two three four) and a
// well-formed English one (one thousand two hundred thirty-four). Classifying
// by position — "three digits after it, so it groups" — reports the French one
// as mis-grouped. So each separator is offered the roles its CHARACTER can
// hold in this language, and only a separator that can hold neither role where
// it stands is a finding. A fraction mark can only be the last separator and
// can only appear once; every earlier separator must group, and must be
// followed by a digit run the language's grouping allows.
//
// WHAT THIS CHECK DOES NOT JUDGE: a scripture reference's chapter-verse
// separator. "Jhn 3.16" is reference-shaped, not a decimal fraction, and
// `scripture-reference`'s rule 3 already owns whether a cell's references
// separate chapter from verse consistently. Numbers inside a reference the
// built-in book spellings recognise are therefore skipped here, so the two
// checks never report the same characters.
//
// The check is OFF by default: a lane with no recorded language resolves no
// conventions at all, and in a language whose digits CLDR records the digit
// rule is a real editorial choice (Arabic and Burmese publications use both
// digit sets) — so, like `scripture-reference`, it is something a project
// turns on rather than something every project inherits.
//
// Pure, and linear in the cell's length, so incremental-infractions re-runs
// only the edited cell.

/** Why a number was flagged. Carried for the tests and a future message builder. */
export type NumberFormatProblem = "separator" | "digits"

/** One separator inside a number, with the length of the digit run after it. */
interface NumberSeparator {
  char: string
  /** Code points in the digit run that follows, 0 when nothing follows. */
  runLength: number
}

/**
 * The separators inside a raw number token, in order. A leading minus is not a
 * separator; `readNumbers` never produces any other non-digit at an edge.
 */
function separators(raw: string): NumberSeparator[] {
  const out: NumberSeparator[] = []
  let pending: string | null = null
  for (const match of raw.matchAll(/\p{Nd}+|[^\p{Nd}]/gu)) {
    const token = match[0]
    if (/\p{Nd}/u.test(token)) {
      if (pending !== null) {
        out.push({ char: pending, runLength: Array.from(token).length })
        pending = null
      }
      continue
    }
    if (token === "-") continue
    if (pending !== null) out.push({ char: pending, runLength: 0 })
    pending = token
  }
  if (pending !== null) out.push({ char: pending, runLength: 0 })
  return out
}

/** True when `raw`'s separators can all be read as this language's own. */
function separatorsFit(raw: string, conventions: NumberFormatConventions): boolean {
  const found = separators(raw)
  if (found.length === 0) return true
  const groups = conventions.group
  const decimals = conventions.decimal
  const sizes = conventions.groupSizes
  for (const [index, separator] of found.entries()) {
    const last = index === found.length - 1
    const canGroup = groups.includes(separator.char) && sizes.includes(separator.runLength)
    // A fraction mark ends the number: only the last separator may be one.
    const canDecimal = last && decimals.includes(separator.char) && separator.runLength > 0
    if (!canGroup && !canDecimal) return false
  }
  return true
}

/** True when every digit in `raw` is one this language writes numbers in. */
function digitsFit(raw: string, conventions: NumberFormatConventions): boolean {
  for (const char of Array.from(raw)) {
    if (!/\p{Nd}/u.test(char)) continue
    if (WESTERN_DIGITS.includes(char)) continue
    if (!conventions.digits.includes(char)) return false
  }
  return true
}

/** The problems one number has in this language. Empty when it is fine. */
export function numberProblems(raw: string, conventions: NumberFormatConventions): NumberFormatProblem[] {
  const problems: NumberFormatProblem[] = []
  if (!digitsFit(raw, conventions)) problems.push("digits")
  if (!separatorsFit(raw, conventions)) problems.push("separator")
  return problems
}

export function runCheck(
  _source: string,
  target: string,
  context?: BuiltinCheckRunContext,
): InfractionSpan[] | null {
  const conventions = context?.numberFormat
  // No recorded language and no profile slot: say nothing rather than judge
  // the lane by some other language's number format.
  if (!conventions) return null

  const numbers = readNumbers(target)
  if (numbers.length === 0) return null

  // A chapter:verse is not a decimal fraction — see the header. Scanned only
  // once a number is already a candidate, so the ordinary cell (numbers that
  // are fine, or none at all) never pays for a second reference scan.
  let references: ScannedReference[] | null = null

  const spans: InfractionSpan[] = []
  for (const number of numbers) {
    if (numberProblems(number.raw, conventions).length === 0) continue
    references ??= scanReferences(target)
    if (references.some((ref) => number.start >= ref.start && number.end <= ref.end)) continue
    spans.push({ side: "target", start: number.start, end: number.end, matchedText: number.raw })
  }

  return spans.length > 0 ? spans : null
}
