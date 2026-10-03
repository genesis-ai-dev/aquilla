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
  const differs: string[] = []
  const missing: string[] = []
  for (const f of findings) {
    if (f.kind === "differs") {
      spans.push({ side: "target", start: f.targetStart, end: f.targetEnd, matchedText: target.slice(f.targetStart, f.targetEnd) })
      if (!differs.includes(f.label)) differs.push(f.label)
    } else {
      spans.push({ side: "source", start: f.sourceStart, end: f.sourceEnd, matchedText: source.slice(f.sourceStart, f.sourceEnd) })
      for (const label of f.labels) if (!missing.includes(label)) missing.push(label)
    }
  }
  const version = bible.versionName
  // A cell can quote two verses: one copied with a word changed, the other
  // translated fresh. The rule engine keeps one reason per check per cell, so
  // "both" carries each list on its own; naming both verses in the "missing"
  // sentence would tell the translator a copied verse was never used.
  if (differs.length > 0 && missing.length > 0) {
    return { spans, params: { kind: "both", refs: differs.join(", "), missingRefs: missing.join(", "), version } }
  }
  return missing.length > 0
    ? { spans, params: { kind: "missing", refs: missing.join(", "), version } }
    : { spans, params: { kind: "differs", refs: differs.join(", "), version } }
}
