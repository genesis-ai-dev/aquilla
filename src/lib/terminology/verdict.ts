/**
 * Per-cell terminology verdict. Shared by the term detail page and the
 * sync-worker occurrence query so a paged list and its enforced/infringed
 * totals cannot disagree.
 */

import { matchesConcept, matchesTerm } from "./match"
import type { ConceptMatchInput, TermMatchingSettings } from "./model"

export type TermVerdict = "enforced" | "infringed" | "na"

/** Target verdict for a cell the source matcher has already accepted. */
export function verdictForKnownMatch(
  concept: ConceptMatchInput,
  translated: string,
): Exclude<TermVerdict, "na"> {
  const renderings = concept.renderings ?? []
  const approved = renderings.filter((r) => r.status === "preferred" || r.status === "admitted")
  const forbidden = renderings.filter((r) => r.status === "forbidden")

  if (forbidden.some((f) => matchesTerm(translated, f.rendering))) return "infringed"
  if (approved.length > 0) {
    return approved.some((a) => matchesTerm(translated, a.rendering)) ? "enforced" : "infringed"
  }
  return "enforced"
}

export function deriveTermVerdict(
  concept: ConceptMatchInput,
  original: string,
  translated: string,
  termMatching?: TermMatchingSettings,
): TermVerdict {
  if (!matchesConcept(original, concept, termMatching)) return "na"
  return verdictForKnownMatch(concept, translated)
}
