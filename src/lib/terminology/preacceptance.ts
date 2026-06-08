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
 * Matching is normalized (case-insensitive, whitespace-collapsed) substring
 * match. No lemmatizer, no network, no back-translation. Inflected forms are a
 * known v2 gap (see TRACES `term-lemmatizer`). Only `active` concepts with a
 * non-empty source term are considered — draft/deprecated concepts and
 * concepts whose source term does not appear in the source are irrelevant and
 * never warn.
 */

import type { Concept } from "./types"

export interface PreAcceptanceWarning {
  conceptId: string
  sourceTerm: string
  kind: "forbidden-present" | "preferred-absent"
  /** The forbidden rendering text found in the completion (forbidden-present only). */
  offendingText?: string
}

/** Lower-case + collapse internal whitespace so substring matching is stable. */
function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim()
}

export function detectPreAcceptanceWarnings(
  completionText: string,
  sourceText: string,
  concepts: Concept[],
): PreAcceptanceWarning[] {
  const normCompletion = normalize(completionText)
  const normSource = normalize(sourceText)
  const warnings: PreAcceptanceWarning[] = []

  for (const concept of concepts) {
    if (concept.status !== "active") continue

    const normTerm = normalize(concept.sourceTerm)
    if (!normTerm) continue

    // Only concepts whose source term actually appears in this source are
    // relevant. Irrelevant concepts never warn.
    if (!normSource.includes(normTerm)) continue

    // (a) Any forbidden rendering present in the completion → louder warning.
    let forbiddenFired = false
    for (const r of concept.renderings) {
      if (r.status !== "forbidden") continue
      const normRendering = normalize(r.rendering)
      if (!normRendering) continue
      if (normCompletion.includes(normRendering)) {
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
      const anyApprovedPresent = approved.some((r) => {
        const n = normalize(r.rendering)
        return n.length > 0 && normCompletion.includes(n)
      })
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
