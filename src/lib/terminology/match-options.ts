/**
 * Resolve a concept's effective matching options from three layers:
 *   concept.match (explicit) > project.termMatching defaults > script-derived.
 *
 * Pure. Every consumer of the matcher goes through here so chips, rules,
 * stats, and the term page never disagree about what a term matches.
 */

import type { Concept, TermMatchingSettings, TermMatchOptions } from "./types"

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

/**
 * Strip a draft's match options down to what the user actually set: undefined
 * keys and empty arrays carry no information, and persisting them would make
 * every concept look like it had explicit overrides. Returns undefined when
 * nothing is left, so callers can omit the field entirely.
 */
export function pruneMatch(match: TermMatchOptions | undefined): TermMatchOptions | undefined {
  if (!match) return undefined
  const out: TermMatchOptions = {}
  if (match.foldMarks !== undefined) out.foldMarks = match.foldMarks
  if (match.affixes !== undefined) out.affixes = match.affixes
  if (match.forms && match.forms.length > 0) out.forms = [...match.forms]
  if (match.excludedForms && match.excludedForms.length > 0) out.excludedForms = [...match.excludedForms]
  return Object.keys(out).length > 0 ? out : undefined
}
