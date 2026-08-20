// lint_rules — deterministic project-rule checks over a span draft (graph
// node `lint_rules`). A pure wrapper around the agent's lintDraft: same
// checks emit-stage runs, surfaced BEFORE verification so the router can
// count flags. Rule loading (loadLintRules) stays with the caller — this
// node takes the already-loaded rules and touches no I/O.

import { lintDraft, type LintRule } from "../agent/lint"
import type { CellPair } from "../agent/tools/select-cells"
import { lintTerminology, type Concept } from "./project-context"
import type { LintFlag, SpanDraft } from "./types"

/**
 * Lint a span draft against the project's hand-authored rules AND its key
 * terms.
 *
 * The terminology half is new. Concepts were compiled to rules in the browser
 * only, so a server-side run could render "grace" three different ways across
 * three passages and nothing on this side would notice — the flags fed the
 * risk router and the redraft loop, which means the run had no way to
 * self-correct the one defect a translation consultant is most certain to
 * reject a book over.
 */
export function lintSpanDraft(
  rules: LintRule[],
  pairs: CellPair[],
  draft: SpanDraft,
  concepts: Concept[] = [],
): LintFlag[] {
  const sourceById = new Map(pairs.map((p) => [p.cellId, p.source]))
  const flags: LintFlag[] = []
  for (const cell of draft.cells) {
    const source = sourceById.get(cell.cellId) ?? ""
    const hits = [
      ...lintDraft(rules, source, cell.text),
      ...lintTerminology(concepts, source, cell.text),
    ]
    for (const hit of hits) {
      flags.push({ spanId: draft.spanId, cellId: cell.cellId, ruleId: hit.ruleId, message: hit.message })
    }
  }
  return flags
}
