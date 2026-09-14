/**
 * Resolve a concept's effective matching options from three layers:
 *   concept.match (explicit) > project.termMatching defaults > script-derived.
 *
 * Pure. Every consumer of the matcher goes through here so chips, rules,
 * stats, and the term page never disagree about what a term matches.
 */

import type { Concept, TermMatchingSettings } from "./types"

export const DEFAULT_MAX_AFFIXES = 2

export interface ResolvedMatchOptions {
  foldMarks: boolean
  affixes: boolean
  forms: string[]
  excludedForms: string[]
  prefixes: string[]
  suffixes: string[]
  maxAffixes: number
}

/**
 * True when the string contains combining marks that survive NFC composition
 * (Hebrew niqqud/cantillation, Arabic harakat, Syriac points). Precomposed
 * Latin letters like é compose back to a single code point and do not count.
 */
export function hasCombiningMarks(s: string): boolean {
  return /\p{M}/u.test(s.normalize("NFC"))
}

export function resolveMatchOptions(
  concept: Pick<Concept, "sourceTerm" | "match">,
  project?: TermMatchingSettings,
): ResolvedMatchOptions {
  const prefixes = (project?.prefixes ?? []).filter((p) => p.length > 0)
  const suffixes = (project?.suffixes ?? []).filter((s) => s.length > 0)
  const hasInventory = prefixes.length > 0 || suffixes.length > 0

  const foldMarks =
    concept.match?.foldMarks ??
    project?.foldMarksDefault ??
    hasCombiningMarks(concept.sourceTerm)

  const affixes = hasInventory && (concept.match?.affixes ?? true)

  return {
    foldMarks,
    affixes,
    forms: (concept.match?.forms ?? []).map((f) => f.trim()).filter((f) => f.length > 0),
    excludedForms: (concept.match?.excludedForms ?? []).map((f) => f.trim()).filter((f) => f.length > 0),
    prefixes,
    suffixes,
    maxAffixes: project?.maxAffixes ?? DEFAULT_MAX_AFFIXES,
  }
}
