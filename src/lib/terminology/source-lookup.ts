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

import { matchesConcept, stripMarks, termMatchingKey } from "./match"
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
 *
 * Memoized per (concepts array, project settings, surface) — AQU-2654. The
 * editor calls this from render, once per highlighted term per row, and every
 * call tests the whole glossary. The termbase array is replaced, never edited
 * in place, when a term changes, so its identity is the cache key and a new
 * array starts a new cache. The returned array is shared: do not mutate it.
 */
export function conceptsForSourceSurface(
  surface: string,
  concepts: readonly Concept[],
  project?: TermMatchingSettings,
): Concept[] {
  let byProject = lookupCache.get(concepts)
  if (!byProject) {
    byProject = new Map()
    lookupCache.set(concepts, byProject)
  }
  const projectKey = termMatchingKey(project)
  let bySurface = byProject.get(projectKey)
  if (!bySurface) {
    bySurface = new Map()
    byProject.set(projectKey, bySurface)
  }
  const hit = bySurface.get(surface)
  if (hit) return hit
  const found = lookUpConcepts(surface, concepts, project)
  // A file has a few thousand distinct highlighted surfaces at most; the cap
  // only bounds a pathological caller.
  if (bySurface.size >= MAX_CACHED_SURFACES) bySurface.clear()
  bySurface.set(surface, found)
  return found
}

const MAX_CACHED_SURFACES = 5000
const lookupCache = new WeakMap<readonly Concept[], Map<string, Map<string, Concept[]>>>()

function lookUpConcepts(
  surface: string,
  concepts: readonly Concept[],
  project?: TermMatchingSettings,
): Concept[] {
  const folded = foldForFragment(surface)
  if (!folded) return []
  return concepts.filter((concept) => answersFolded(surface, folded, concept, project))
}

/** One concept's answer — the predicate `conceptsForSourceSurface` filters with. */
function answersFolded(
  surface: string,
  folded: string,
  concept: Concept,
  project: TermMatchingSettings | undefined,
): boolean {
  if (concept.status !== "active") return false
  const lexical = lexicalFormsOf(concept)
  // Exclusions win over both grounds below.
  if (lexical.excluded.includes(folded)) return false
  if (matchesConcept(surface, concept, project)) return true
  return lexical.headwords.some((headword) => headword.includes(folded))
}

/**
 * Whether ONE concept is among `conceptsForSourceSurface(surface, …)` — the
 * same predicate, asked of a concept the caller already holds. The source
 * column knows which concepts matched a highlighted span; asking them is how
 * it learns the lookup is not empty without testing the glossary (AQU-2654).
 */
export function conceptAnswersSourceSurface(
  surface: string,
  concept: Concept,
  project?: TermMatchingSettings,
): boolean {
  const folded = foldForFragment(surface)
  return folded.length > 0 && answersFolded(surface, folded, concept, project)
}

interface LexicalForms {
  sourceTerm: string
  match: Concept["match"]
  /** `foldForFragment` of each excluded form. */
  excluded: string[]
  /** `foldForFragment` of the headword and each listed form, blanks dropped. */
  headwords: string[]
}

const lexicalForms = new WeakMap<Concept, LexicalForms>()

/**
 * The folded strings the lexical grounds compare against. They depend on the
 * concept alone (the project's settings add affixes and a fold default,
 * neither of which the fragment test reads), and folding them per lookup was
 * two normalizations per form per concept per surface.
 */
function lexicalFormsOf(concept: Concept): LexicalForms {
  let entry = lexicalForms.get(concept)
  if (!entry || entry.sourceTerm !== concept.sourceTerm || entry.match !== concept.match) {
    const resolved = resolveMatchOptions(concept)
    entry = {
      sourceTerm: concept.sourceTerm,
      match: concept.match,
      excluded: resolved.excludedForms.map(foldForFragment),
      headwords: [concept.sourceTerm, ...resolved.forms].map(foldForFragment).filter((h) => h.length > 0),
    }
    lexicalForms.set(concept, entry)
  }
  return entry
}

const activeByArray = new WeakMap<readonly Concept[], Concept[]>()

/**
 * The active concepts of a termbase array, as ONE array per input array. Every
 * source row filters the same glossary; a filter per row gives each row its
 * own array, and every cache keyed on the array (the lookup above, the
 * matcher's candidate index) then starts empty for each row.
 */
export function activeConceptsOf(concepts: readonly Concept[]): Concept[] {
  let active = activeByArray.get(concepts)
  if (!active) {
    active = concepts.filter((c) => c.status === "active")
    activeByArray.set(concepts, active)
  }
  return active
}

/** True when a source-side surface string has at least one lookup target. */
export function hasSourceTermMatch(
  surface: string,
  concepts: readonly Concept[],
  project?: TermMatchingSettings,
): boolean {
  return conceptsForSourceSurface(surface, concepts, project).length > 0
}
