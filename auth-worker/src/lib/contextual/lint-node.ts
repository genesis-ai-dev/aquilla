// lint_rules — deterministic project-rule checks over a span draft (graph
// node `lint_rules`). A pure wrapper around the agent's lintDraft: same
// checks emit-stage runs, surfaced BEFORE verification so the router can
// count flags. Rule loading (loadLintRules) stays with the caller — this
// node takes the already-loaded rules and touches no I/O.

import { lintDraft, type LintRule } from "../agent/lint"
import type { CellPair } from "../agent/tools/select-cells"
import type { LintFlag, SpanDraft } from "./types"

export function lintSpanDraft(rules: LintRule[], pairs: CellPair[], draft: SpanDraft): LintFlag[] {
  const sourceById = new Map(pairs.map((p) => [p.cellId, p.source]))
  const flags: LintFlag[] = []
  for (const cell of draft.cells) {
    const hits = lintDraft(rules, sourceById.get(cell.cellId) ?? "", cell.text)
    for (const hit of hits) {
      flags.push({ spanId: draft.spanId, cellId: cell.cellId, ruleId: hit.ruleId, message: hit.message })
    }
  }
  return flags
}
