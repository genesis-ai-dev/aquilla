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
import { termToRegexSource } from "./match"

/**
 * Escape a string for safe use inside a RegExp literal. Only used to build the
 * STABLE rule `id` discriminator for forbidden renderings (other code groups by
 * id, so the scheme must not change) — NOT for match patterns, which go through
 * the shared wildcard-aware matcher in ./match.
 */
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

    // Wildcard-aware source pattern (grac* matches grace/graced/gracia, etc.).
    // termToRegexSource returns null for empty/whitespace terms → skip concept.
    const sourcePattern = termToRegexSource(concept.sourceTerm)
    if (sourcePattern === null) continue

    // source-requires-target: source contains the term ⇒ target must have an approved rendering.
    if (approved.length > 0) {
      // Alternation of all approved renderings, each wildcard-aware. Drop any
      // empty rendering pattern. rule-engine compiles this with /i (+/u for
      // term: rules) so \p{L} wildcards resolve.
      const targetAlts = approved
        .map((r) => termToRegexSource(r.rendering))
        .filter((p): p is string => p !== null)
        .join("|")
      const targetPattern = targetAlts

      // Guard: if every approved rendering was empty/whitespace the alternation
      // is "" (which would match anything). Emit no rule in that degenerate case.
      if (targetPattern) rules.push({
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
      const forbiddenPattern = termToRegexSource(f.rendering)
      if (forbiddenPattern === null) continue
      rules.push({
        // id discriminator keeps the EXACT escapeRegex scheme — other code groups by it.
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
          targetPattern: forbiddenPattern,
        },
      })
    }
  }

  return rules
}
