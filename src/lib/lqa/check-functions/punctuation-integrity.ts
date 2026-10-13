import type { InfractionSpan } from "@/lib/parsers/types"
import type { BuiltinCheckRunContext } from "../builtin-run-context"
import { UNIVERSAL_PUNCTUATION } from "../../../../db/shared/punctuation-conventions"

export const MESSAGE = "Clause punctuation from source missing in translation"

// Structural, clause-level marks that carry meaning and are normally preserved
// across a translation. Terminal .?! are handled by end-punctuation-mismatch;
// this catches *mid-cell* drops — e.g. a source ":" flattened to a "." in the
// target, which the end-only check never sees (AQU-587).
//
// AQU-1906: the SOURCE is scanned with the universal marks (": ：" and "; ；"),
// while the TARGET may answer with its own language's equivalents — Arabic "؛"
// for a ";", Greek "·", Ethiopic "፤". Conventions only ADD target marks, so a
// cell that passed before cannot start failing here.
const CLAUSE_CLASSES = ["colon", "semicolon"] as const

export function runCheck(
  source: string,
  target: string,
  context?: BuiltinCheckRunContext,
): InfractionSpan[] | null {
  const effective = context?.punctuation ?? UNIVERSAL_PUNCTUATION
  const spans: InfractionSpan[] = []

  for (const clause of CLAUSE_CLASSES) {
    const sourceMarks = new Set<string>(UNIVERSAL_PUNCTUATION[clause])
    const positions: number[] = []
    for (let i = 0; i < source.length; i++) {
      if (sourceMarks.has(source[i])) positions.push(i)
    }
    if (positions.length === 0) continue // source doesn't use this mark
    const targetMarks = new Set<string>(effective[clause])
    let preserved = false
    for (const char of target) {
      if (targetMarks.has(char)) { preserved = true; break }
    }
    if (preserved) continue // target preserves it somewhere
    // Present in source, entirely absent from target → flag every occurrence so
    // a cell that drops several marks surfaces several spans, not just one.
    for (const i of positions) {
      spans.push({ side: "source", start: i, end: i + 1, matchedText: source[i] })
    }
  }

  return spans.length > 0 ? spans : null
}
