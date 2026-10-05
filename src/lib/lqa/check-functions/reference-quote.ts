// AQU-1573: the "Reference Bible quotes" built-in check.
//
// A sermon line that cites a verse ("Isaiah 40:25 says, ...") must quote that
// verse in the wording of the Bible the lane quotes from (Van Dyck for LOTE's
// Arabic), and must keep the reference itself. This adapts the shared quote
// check (src/lib/reference-bible/quote-check.ts) and reference check
// (reference-kept.ts), which the agent's staging lint runs too, to the rule
// engine's span shape:
//
//   differs  -> a TARGET span over the quoted part that changes, adds or
//              drops words;
//   missing  -> a SOURCE span over the reference, when the source visibly
//              quotes the verse but the draft does not use the Bible's wording;
//   dropped  -> a SOURCE span over the reference, when the draft leaves out
//              the reference's chapter and verse numbers.
//
// The quote findings need the lane's Bible, which only the caller knows, so
// they read it from the check context. Without one (a lane with no reference
// Bible, or a caller such as a proposal card that does not pass a context)
// they find nothing, and a reference whose verses have not loaded yet is
// skipped, so a slow lookup never shows a false warning. "dropped" needs no
// verse text, so it runs with or without a Bible. A warning only: it never
// blocks anything.

import type { InfractionSpan } from "@/lib/parsers/types"
import { checkReferenceQuotes } from "@/lib/reference-bible/quote-check"
import { findScriptureReferences } from "@/lib/reference-bible/reference-finder"
import { findDroppedReferences } from "@/lib/reference-bible/reference-kept"
import type { BuiltinCheckContext, BuiltinCheckResult } from "../check-context"

export const MESSAGE = "A quoted Bible verse does not match the reference Bible"

export function runCheck(source: string, target: string, ctx?: BuiltinCheckContext): BuiltinCheckResult {
  if (!source || !/\d/.test(source)) return null
  const bible = ctx?.referenceBible
  const references = bible?.references?.(source) ?? findScriptureReferences(source)
  if (references.length === 0) return null
  const findings = bible ? checkReferenceQuotes(source, target, bible.lookup, { references }) : []
  const dropped = findDroppedReferences(source, target, { references })
  if (findings.length === 0 && dropped.length === 0) return null

  const spans: InfractionSpan[] = []
  const addSourceSpan = (start: number, end: number) => {
    if (spans.some((s) => s.side === "source" && s.start === start && s.end === end)) return
    spans.push({ side: "source", start, end, matchedText: source.slice(start, end) })
  }
  const differs: string[] = []
  const missing: string[] = []
  for (const f of findings) {
    if (f.kind === "differs") {
      spans.push({ side: "target", start: f.targetStart, end: f.targetEnd, matchedText: target.slice(f.targetStart, f.targetEnd) })
      if (!differs.includes(f.label)) differs.push(f.label)
    } else {
      addSourceSpan(f.sourceStart, f.sourceEnd)
      for (const label of f.labels) if (!missing.includes(label)) missing.push(label)
    }
  }
  for (const d of dropped) addSourceSpan(d.sourceStart, d.sourceEnd)

  const version: Record<string, string> = bible ? { version: bible.versionName } : {}
  // Dropped references ride along with whichever quote sentence the cell
  // gets, as their own list: the rule engine keeps one reason per check per
  // cell, and each sentence must name only its own verses.
  const droppedRefs = dropped.map((d) => d.label).join(", ")
  const droppedCount = String(dropped.length)
  const withDropped: Record<string, string> = dropped.length > 0 ? { droppedRefs, droppedCount } : {}
  // A cell can quote two verses: one copied with a word changed, the other
  // translated fresh. "both" carries each list on its own; naming both verses
  // in the "missing" sentence would tell the translator a copied verse was
  // never used.
  if (differs.length > 0 && missing.length > 0) {
    return { spans, params: { kind: "both", refs: differs.join(", "), missingRefs: missing.join(", "), ...version, ...withDropped } }
  }
  if (missing.length > 0) return { spans, params: { kind: "missing", refs: missing.join(", "), ...version, ...withDropped } }
  if (differs.length > 0) return { spans, params: { kind: "differs", refs: differs.join(", "), ...version, ...withDropped } }
  return { spans, params: { kind: "dropped", refs: droppedRefs, count: droppedCount, ...version } }
}
