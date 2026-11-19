import type { InfractionSpan } from "@/lib/parsers/types"
import { findOldOrthography } from "../../../../db/shared/orthography"
import type { BuiltinCheckRunContext } from "../builtin-run-context"

export const MESSAGE = "Word is written in the orthography this lane replaced"

// AQU-2628: the human half of the per-lane orthography transform.
//
// Import and AI drafting run every incoming word through the converter
// (db/shared/orthography.ts), so the only text that can still reach a cell in
// the old spelling is text a PERSON typed. This check is what tells them, and
// it reads exactly the config the converter reads — one source of truth, so
// the underline can never disagree with what Fix would write.
//
// Three consequences worth stating, because each is a bug if it stops being
// true:
//
//   * It runs on the TARGET only. A source cell is the publisher's text in
//     whatever orthography they sent, and re-spelling someone else's source
//     is not this feature's business.
//   * It never flags an APPROVED exception. `Isʼhoq` keeps `s` and `h` apart
//     on purpose; a word a contributor has only PROPOSED still flags, which
//     is how the proposal stays visible until a maintainer rules on it.
//   * If it ever fires on an AI draft, the drafting call site is broken —
//     that is a bug in the converter's wiring, not a finding about the draft.
//
// Silent without the slot: with no `orthography` block there are no rules to
// judge a word by, and inventing some would underline correct spelling in
// every project that has nothing to do with a new alphabet.
//
// Pure and linear in the cell's length, so incremental-infractions re-runs
// only the edited cell.

export function runCheck(
  _source: string,
  target: string,
  context?: BuiltinCheckRunContext,
): InfractionSpan[] | null {
  const orthography = context?.orthography
  if (!orthography) return null

  const findings = findOldOrthography(target, orthography)
  if (findings.length === 0) return null

  return findings.map(
    (finding): InfractionSpan => ({
      side: "target",
      start: finding.start,
      end: finding.end,
      matchedText: finding.text,
    }),
  )
}

/**
 * What the lane's rules would make of the first flagged word, for the
 * finding's sentence ("use “şahar” for “shahar”"). Returns null when the
 * suggestion would not help — no context, or nothing flagged.
 */
export function suggestionFor(
  spans: readonly InfractionSpan[],
  context: BuiltinCheckRunContext | undefined,
): { word: string; suggestion: string } | null {
  const first = spans[0]
  if (!first || !context?.orthography) return null
  const [finding] = findOldOrthography(first.matchedText, context.orthography)
  return finding ? { word: finding.text, suggestion: finding.suggestion } : null
}
