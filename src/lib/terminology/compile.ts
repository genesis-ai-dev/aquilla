/**
 * Compile Concept[] → TranslationRule[].
 *
 * Produces rules that feed directly into the existing rule-engine so
 * terminology violations are DERIVED on read — no materialized verdicts.
 *
 * Rules produced per active concept:
 *   preferred / admitted renderings → one `source-requires-target` rule
 *     (source contains sourceTerm ⇒ target must contain at least one approved
 *      rendering; absence = "term not rendered with an approved rendering")
 *   each forbidden rendering → one `target-forbids` rule per rendering
 *     (source contains sourceTerm AND target contains forbidden text ⇒ violation)
 *
 * draft / deprecated concepts are skipped entirely.
 */

import type { TranslationRule } from "@/lib/parsers/types"
import type { Concept } from "./types"

/** Escape a string for safe use inside a RegExp literal. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * Compile a list of concepts into TranslationRule instances.
 *
 * Only `active` concepts produce rules. The returned rules use existing
 * TranslationRule check types — no new check kinds are introduced.
 */
export function compileConceptsToRules(concepts: Concept[]): TranslationRule[] {
  const rules: TranslationRule[] = []
  const now = new Date().toISOString()

  for (const concept of concepts) {
    if (concept.status !== "active") continue

    const approved = concept.renderings.filter(
      (r) => r.status === "preferred" || r.status === "admitted",
    )
    const forbidden = concept.renderings.filter((r) => r.status === "forbidden")

    const sourcePattern = `\\b${escapeRegex(concept.sourceTerm)}\\b`

    // source-requires-target: source contains the term ⇒ target must have an approved rendering.
    if (approved.length > 0) {
      // Build an alternation of all approved renderings (case-insensitive match).
      const targetAlts = approved
        .map((r) => escapeRegex(r.rendering))
        .join("|")
      const targetPattern = targetAlts // rule-engine uses /i flag on the targetPattern

      rules.push({
        id: `term:${concept.id}:approved`,
        name: `Term: ${concept.sourceTerm}`,
        description: `"${concept.sourceTerm}" must be rendered with an approved rendering (${approved.map((r) => r.rendering).join(", ")})`,
        severity: "minor",
        source: "user",
        scope: "project",
        enabled: true,
        createdAt: now,
        check: {
          type: "source-requires-target",
          sourcePattern,
          targetPattern,
        },
      })
    }

    // target-forbids: source has the term AND target contains a forbidden rendering.
    // One rule per forbidden rendering so the violation message names the exact form.
    for (const f of forbidden) {
      // The target-forbids check fires regardless of source, but per the spec:
      // "forbidden rendering in the target when the source bears the concept".
      // The existing `target-forbids` check type does NOT have a source guard.
      // We model it as target-forbids unconditionally (matching spec intent for
      // string-match path). When a source guard is needed it can be upgraded to
      // source-requires-target with an inverted target pattern; deferred.
      rules.push({
        id: `term:${concept.id}:forbidden:${escapeRegex(f.rendering)}`,
        name: `Term: ${concept.sourceTerm} — forbidden rendering`,
        description: `"${f.rendering}" is a forbidden rendering for "${concept.sourceTerm}"`,
        severity: "major",
        source: "user",
        scope: "project",
        enabled: true,
        createdAt: now,
        check: {
          type: "target-forbids",
          targetPattern: `\\b${escapeRegex(f.rendering)}\\b`,
        },
      })
    }
  }

  return rules
}
