// Bible data checks inside the rule engine (AQU-1688).
//
// The checks themselves live in db/shared/bible-checks, shared with the
// workers. This adapter turns one finding into the engine's RuleInfraction:
// the reason stays a code (`builtin:bkp:V2`), and the finding's own reason,
// params and pack evidence travel as `reasonParams` strings, which
// src/lib/bible-data/check-messages.ts renders through t().

import type { InfractionSpan, RuleInfraction } from "@/lib/parsers/types"
import { evaluateCell } from "../../../db/shared/bible-checks/evaluate"
import type {
  BibleCheckFinding,
  BibleCheckId,
  CellExpectation,
} from "../../../db/shared/bible-checks/types"
import type { LanguageProfile } from "../../../db/shared/language-profile"

/**
 * What one cell's Bible data checks read besides its own text: the facts the
 * pack gives for that cell, compiled once per file, and the project's
 * Language profile. Never another cell's text.
 */
export interface BibleCellCheckInput {
  expectation: CellExpectation
  profile: LanguageProfile
}

// The engine runs one cell's rules back to back, so the eight Bible data rules
// share one evaluation of the text. Same text and same input object, same
// findings: this is a cache, not state.
let last: { text: string; input: BibleCellCheckInput; findings: BibleCheckFinding[] } | null = null

function findingsFor(text: string, input: BibleCellCheckInput): BibleCheckFinding[] {
  if (last && last.text === text && last.input === input) return last.findings
  const findings = evaluateCell(text, input.expectation, input.profile)
  last = { text, input, findings }
  return findings
}

/** A finding as flat strings, for `RuleInfraction.reasonParams`. */
export function bibleReasonParams(finding: BibleCheckFinding): Record<string, string> {
  const params: Record<string, string> = { ...finding.params, kind: finding.reason, evidence: finding.evidence.kind }
  if (finding.approximate) params.approximate = "true"
  const evidence = finding.evidence
  if (evidence.kind === "speech") {
    params.startRef = evidence.startRef
    params.startWord = String(evidence.startWord)
    params.endRef = evidence.endRef
    params.endWord = String(evidence.endWord)
    params.speakerSources = evidence.speakerSources.join(",")
    params.speakerConf = String(evidence.speakerConf)
  } else {
    params.refs = evidence.refs.join(",")
  }
  return params
}

/** The infraction for one Bible data rule on one cell, or null. No input means the check cannot run here. */
export function bibleCheckInfraction(
  ruleId: string,
  checkId: BibleCheckId,
  cellId: string,
  fileId: string,
  text: string,
  input: BibleCellCheckInput | undefined,
): RuleInfraction | null {
  if (!input) return null
  const finding = findingsFor(text, input).find((f) => f.code === checkId)
  if (!finding) return null
  const spans: InfractionSpan[] = finding.spans.map(({ start, end }) => ({
    side: "target",
    start,
    end,
    matchedText: text.slice(start, end),
  }))
  return {
    ruleId,
    cellId,
    fileId,
    reason: `builtin:${checkId}`,
    reasonParams: bibleReasonParams(finding),
    spans,
  }
}
