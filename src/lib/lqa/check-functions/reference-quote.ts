// AQU-1573: the "Reference Bible quotes" built-in check.
//
// A sermon line that cites a verse ("Isaiah 40:25 says, ...") must quote that
// verse in the wording of the Bible the lane quotes from (Van Dyck for LOTE's
// Arabic). This adapts the shared quote check (src/lib/reference-bible/
// quote-check.ts, which the agent's staging lint runs too) to the rule
// engine's span shape:
//
//   differs  -> a TARGET span over the quoted part that changes, adds or
//              drops words;
//   missing  -> a SOURCE span over the reference, when the source visibly
//              quotes the verse but the draft does not use the Bible's wording.
//
// It needs the lane's Bible, which only the caller knows, so it reads it from
// the check context. Without one (a lane with no reference Bible, or a caller
// such as a proposal card that does not pass a context) it finds nothing, and
// a reference whose verses have not loaded yet is skipped, so a slow lookup
// never shows a false warning. A warning only: it never blocks anything.

import type { InfractionSpan } from "@/lib/parsers/types"
import { checkReferenceQuotes } from "@/lib/reference-bible/quote-check"
import type { BuiltinCheckContext, BuiltinCheckResult } from "../check-context"

export const MESSAGE = "A quoted Bible verse does not match the reference Bible"

export function runCheck(source: string, target: string, ctx?: BuiltinCheckContext): BuiltinCheckResult {
  const bible = ctx?.referenceBible
  if (!bible || !source || !/\d/.test(source)) return null
  const references = bible.references?.(source)
  if (references && references.length === 0) return null
  const findings = checkReferenceQuotes(source, target, bible.lookup, references ? { references } : {})
  if (findings.length === 0) return null

  const spans: InfractionSpan[] = []
  const labels: string[] = []
  let kind: "differs" | "missing" = "differs"
  for (const f of findings) {
    if (f.kind === "differs") {
      spans.push({ side: "target", start: f.targetStart, end: f.targetEnd, matchedText: target.slice(f.targetStart, f.targetEnd) })
      if (!labels.includes(f.label)) labels.push(f.label)
    } else {
      // "missing" is only reported when no referenced passage was quoted at
      // all, so it never shares a cell with a "differs".
      kind = "missing"
      spans.push({ side: "source", start: f.sourceStart, end: f.sourceEnd, matchedText: source.slice(f.sourceStart, f.sourceEnd) })
      for (const label of f.labels) if (!labels.includes(label)) labels.push(label)
    }
  }
  return { spans, params: { kind, refs: labels.join(", "), version: bible.versionName } }
}
