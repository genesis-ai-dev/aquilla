/**
 * Which managed concepts a SOURCE-side surface string should look up (AQU-1272).
 *
 * The source column has two lookup affordances — the read-mode popover over a
 * highlighted span (`SourceWithTermLookup`, `decorateTermsInHtml`) and the
 * "View term" button on a selection (`SourceSelectionToolbar`) — and both used
 * to answer "is this a managed term?" with `String.includes()` against
 * `concept.sourceTerm`. That disagreed with enforcement, the editor chips, the
 * occurrence stats and the term page the moment a concept used mark folding,
 * an affix inventory, extra `match.forms` or `match.excludedForms`: a prefixed
 * or differently-pointed occurrence (וְהָאָ֗רֶץ for the term הָאָ֗רֶץ) was silent
 * on exactly the forms the feature had just learned to recognise, while an
 * unrelated substring neighbour lit up on luck.
 *
 * So the matcher is the verdict here too. `conceptsForSourceSurface` is the one
 * answer both surfaces ask for, and it accepts a concept on either of two
 * grounds:
 *
 *  1. **The matcher matches the surface** — `matchesConcept(surface, …)`, which
 *     brings wildcards, mark folding, affixes, `forms` and `excludedForms` in
 *     line with every other consumer of `match.ts`.
 *  2. **The surface is a fragment of the entry's own headword or a listed
 *     form** — selecting "Spirit" inside the entry "Holy Spirit" still opens
 *     it. This is a *lookup* affordance, not enforcement: a reader asking what
 *     a word belongs to should reach the longer entry that contains it.
 *
 * Only the second ground is lexical, and it is deliberately one-directional:
 * the old "surface contains the term" test is what `matchesConcept` now does
 * properly (whole-word, script-aware), so keeping it as a substring test is
 * what made "graceful" look like the term "grace".
 *
 * An excluded surface form is rejected on BOTH grounds. `matchesConcept`
 * already honours `excludedForms`; the fragment ground is checked against the
 * same list so an exclusion can never be undone by the lexical path.
 */

import { matchesConcept, stripMarks } from "./match"
import { resolveMatchOptions } from "./match-options"
import type { Concept, TermMatchingSettings } from "./types"

/**
 * Fold a surface/headword for the lexical fragment test: trim, drop edge
 * punctuation (a highlighted token keeps its visible comma; the entry does
 * not), lowercase, and strip combining marks so pointing never decides a
 * fragment. Mark stripping is intentionally unconditional here — the fragment
 * ground is a reader's convenience, and a stricter rule than the matcher's
 * `foldMarks` would only produce a second, quieter disagreement.
 */
function foldForFragment(value: string): string {
  return stripMarks(
    value
      .trim()
      .toLocaleLowerCase()
      .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""),
  )
}

/**
 * The active concepts a source-side surface string should offer a lookup for,
 * in the order they were given. `project` carries the affix inventory and fold
 * defaults, exactly as it does for every other `match.ts` caller.
 */
export function conceptsForSourceSurface(
  surface: string,
  concepts: readonly Concept[],
  project?: TermMatchingSettings,
): Concept[] {
  const folded = foldForFragment(surface)
  if (!folded) return []

  return concepts.filter((concept) => {
    if (concept.status !== "active") return false
    const resolved = resolveMatchOptions(concept, project)
    // Exclusions win over both grounds below.
    if (resolved.excludedForms.some((f) => foldForFragment(f) === folded)) return false
    if (matchesConcept(surface, concept, project)) return true
    return [concept.sourceTerm, ...resolved.forms].some((headword) => {
      const foldedHeadword = foldForFragment(headword)
      return foldedHeadword.length > 0 && foldedHeadword.includes(folded)
    })
  })
}

/** True when a source-side surface string has at least one lookup target. */
export function hasSourceTermMatch(
  surface: string,
  concepts: readonly Concept[],
  project?: TermMatchingSettings,
): boolean {
  return conceptsForSourceSurface(surface, concepts, project).length > 0
}
