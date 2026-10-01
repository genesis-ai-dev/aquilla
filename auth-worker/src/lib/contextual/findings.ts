// findings — categorical QA codes for a cell the pipeline accepted
// (docs/superpowers/specs/2026-09-30-agent-pr-threads-design.md §1).
//
// Codes only: raw verifier or model prose is never durable (see
// ContextualSpanReason in db/shared/contextual-runs.ts). A reviewer sees
// "naturalness disagreed", not the verifier's paragraph.

import type { SupportSignal } from "./support"
import type { LintFlag, Vote } from "./types"

export type FindingCode = `dissent:${string}` | `lint:${string}` | "unsupported" | "redrafted"

export function cellFindings(
  cellId: string,
  input: { votes: Vote[]; flags: LintFlag[]; support?: SupportSignal; redrafted: boolean },
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
    out.push(`lint:${ruleId}`)
  }
  if (input.support?.riskyCellIds.includes(cellId)) out.push("unsupported")
  if (input.redrafted) out.push("redrafted")
  return out
}
