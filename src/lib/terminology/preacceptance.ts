/**
 * Pre-acceptance terminology warning detection (Slice 4).
 *
 * Pure, deterministic, fast string-match check that runs the instant the AI
 * copilot returns a completion — BEFORE the translator accepts it. It is
 * ADVISORY ONLY: it never blocks a commit. Two signals fire:
 *
 *   (a) forbidden-present — the completion directly contains a `forbidden`
 *       rendering of a concept whose source term appears in the source text.
 *   (b) preferred-absent — the source bears a concept (its source term appears
 *       in the source text) but NONE of that concept's preferred/admitted
 *       renderings appear in the completion.
 *
 * Matching uses the shared wildcard-aware matcher (./match): case-insensitive,
 * Unicode-aware, word-boundary, with `*` standing for an inflectional
 * letter-run. So a managed term `grac*` warns on grace/graced/gracia. No
 * lemmatizer, no network, no back-translation. Only `active` concepts with a
 * non-empty source term are considered — draft/deprecated concepts and
 * concepts whose source term does not appear in the source are irrelevant and
 * never warn.
 */

import type { Concept } from "./types"
import { matchesTerm } from "./match"

export interface PreAcceptanceWarning {
  conceptId: string
  sourceTerm: string
  kind: "forbidden-present" | "preferred-absent"
  /** The forbidden rendering text found in the completion (forbidden-present only). */
  offendingText?: string
}

export function detectPreAcceptanceWarnings(
  completionText: string,
  sourceText: string,
  concepts: Concept[],
): PreAcceptanceWarning[] {
  const warnings: PreAcceptanceWarning[] = []

  for (const concept of concepts) {
    if (concept.status !== "active") continue

    if (!concept.sourceTerm.trim()) continue

    // Only concepts whose source term actually appears in this source are
    // relevant. Irrelevant concepts never warn. Wildcard-aware match.
    if (!matchesTerm(sourceText, concept.sourceTerm)) continue

    // (a) Any forbidden rendering present in the completion → louder warning.
    let forbiddenFired = false
    for (const r of concept.renderings) {
      if (r.status !== "forbidden") continue
      if (!r.rendering.trim()) continue
      if (matchesTerm(completionText, r.rendering)) {
        warnings.push({
          conceptId: concept.id,
          sourceTerm: concept.sourceTerm,
          kind: "forbidden-present",
          offendingText: r.rendering,
        })
        forbiddenFired = true
      }
    }

    // (b) None of the approved (preferred/admitted) renderings present →
    // the required term is missing. Skip if there are no approved renderings
    // to look for (nothing to require).
    const approved = concept.renderings.filter(
      (r) => r.status === "preferred" || r.status === "admitted",
    )
    if (approved.length > 0) {
      const anyApprovedPresent = approved.some(
        (r) => r.rendering.trim().length > 0 && matchesTerm(completionText, r.rendering),
      )
      if (!anyApprovedPresent) {
        warnings.push({
          conceptId: concept.id,
          sourceTerm: concept.sourceTerm,
          kind: "preferred-absent",
        })
      }
    }

    // forbiddenFired is intentionally allowed to coexist with preferred-absent:
    // a completion can use a forbidden term AND lack any approved one.
    void forbiddenFired
  }

  return warnings
}
