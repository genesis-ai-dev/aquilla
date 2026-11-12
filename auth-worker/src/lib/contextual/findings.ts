// findings — categorical QA codes for a cell the pipeline accepted
// (docs/superpowers/specs/2026-09-30-agent-pr-threads-design.md §1).
//
// Codes only: raw verifier or model prose is never durable (see
// ContextualSpanReason in db/shared/contextual-runs.ts). A reviewer sees
// "naturalness disagreed", not the verifier's paragraph.
//
// AQU-1690: a Bible data finding keeps its own code, `bkp:<check>`, both for
// the shared evaluator's checks (bkp:V2) and for a question Jev answered "no"
// with its question active (bkp:V13).

import { isBibleCode } from "./bible-gates"
import type { SupportSignal } from "./support"
import type { LintFlag, Vote } from "./types"

export type FindingCode = `dissent:${string}` | `lint:${string}` | `bkp:${string}` | "unsupported" | "redrafted"

export function cellFindings(
  cellId: string,
  input: {
    votes: Vote[]
    flags: LintFlag[]
    support?: SupportSignal
    redrafted: boolean
    /** Bible data codes from the Jev questions (active ones only), for this cell. */
    bible?: readonly `bkp:${string}`[]
  },
): FindingCode[] {
  const out: FindingCode[] = []
  for (const v of input.votes) {
    // An ambiguity "no" vetoes the cell outright (quorum.ts), so it can only
    // appear here for a cell that was never staged — skip it.
    if (v.verifier === "ambiguity") continue
    const explicit = v.cellVerdicts.find((c) => c.cellId === cellId)
    const approve = explicit ? explicit.approve : v.approve
    if (!approve) out.push(`dissent:${v.verifier}`)
  }
  for (const ruleId of new Set(input.flags.filter((f) => f.cellId === cellId).map((f) => f.ruleId))) {
    out.push(isBibleCode(ruleId) ? ruleId : `lint:${ruleId}`)
  }
  for (const code of input.bible ?? []) if (!out.includes(code)) out.push(code)
  if (input.support?.riskyCellIds.includes(cellId)) out.push("unsupported")
  if (input.redrafted) out.push("redrafted")
  return out
}
