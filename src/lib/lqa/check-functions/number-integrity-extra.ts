import type { InfractionSpan } from "@/lib/parsers/types"
import { readNumbers } from "./number-integrity"

export const MESSAGE = "Number in translation not found in source"

// AQU-1761: the other direction of Number integrity. That check makes sure
// every number in the source reaches the translation; this one flags a number
// the translation has and the source doesn't, so a number the translator ADDED
// no longer slips through. (A changed number was already caught: the source's
// number goes missing.)
//
// It reads numbers exactly as Number integrity does (`readNumbers`): any
// script's decimal digits compared by value, so ٤٠ against 40 is not an extra.
//
// Unlike the source direction, occurrences count. A source with 40 once and a
// translation with 40 twice has one extra 40, and the underline goes on the
// later one: each translation number uses up one matching source number, in
// order.
//
// It's a separate built-in check rather than an option on Number integrity, so
// a project can switch it off or change its severity on its own: an extra
// number is sometimes legitimate (an added verse reference, "forty" in the
// source written as "40"), which is also why it defaults to minor.
export function runCheck(source: string, target: string): InfractionSpan[] | null {
  const targetNumbers = readNumbers(target)
  if (targetNumbers.length === 0) return null

  const unused = new Map<string, number>()
  for (const n of readNumbers(source)) unused.set(n.value, (unused.get(n.value) ?? 0) + 1)

  const extra: InfractionSpan[] = []
  for (const n of targetNumbers) {
    const left = unused.get(n.value) ?? 0
    if (left > 0) {
      unused.set(n.value, left - 1)
      continue
    }
    extra.push({ side: "target", start: n.start, end: n.end, matchedText: n.raw })
  }

  return extra.length > 0 ? extra : null
}
