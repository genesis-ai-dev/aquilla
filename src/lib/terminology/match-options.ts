/**
 * Resolve a concept's effective matching options from three layers:
 *   concept.match (explicit) > project.termMatching defaults > script-derived.
 *
 * Pure. Every consumer of the matcher goes through here so chips, rules,
 * stats, and the term page never disagree about what a term matches.
 */

import type { ConceptMatchInput, TermMatchingSettings, TermMatchOptions } from "./model"

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

/**
 * True when the string carries a Greek accent that NFC has composed into the
 * letter — καί is κ, α, U+03AF and καὶ is κ, α, U+1F76, neither with a
 * combining mark left for `hasCombiningMarks` to see (AQU-1936).
 */
export function hasPrecomposedGreekAccent(s: string): boolean {
  for (const ch of s) {
    if (!/\p{Script=Greek}/u.test(ch)) continue
    if (/\p{M}/u.test(ch.normalize("NFD"))) return true
  }
  return false
}

/**
 * True when a term's diacritics are ones mark folding should ignore by default.
 *
 * Two arms, because the scripts differ in kind as well as in encoding
 * (AQU-1936). The combining-mark arm is the pointed scripts: Hebrew, Arabic,
 * Syriac, where the points are a reading aid over a consonantal skeleton, so
 * the same word turns up pointed, differently pointed and unpointed.
 *
 * The Greek arm is accent, which is PROSODIC: the identical word is written
 * καί in isolation and καὶ before an enclitic, so an acute/grave/circumflex
 * difference is never a different word, and asking the user to add each accent
 * as an extra form is asking them to enumerate grammar.
 *
 * Latin is deliberately NOT here, even though NFC composes its diacritics the
 * same way. Latin accents distinguish words a reader would not accept merging
 * — Spanish `año`/`ano`, French `ou`/`où` — so folding stays opt-in there.
 * Adding another script to this default is that same judgment call, not a
 * Unicode detail.
 */
export function hasFoldableDiacritics(s: string): boolean {
  return hasCombiningMarks(s) || hasPrecomposedGreekAccent(s)
}

export function resolveMatchOptions(
  concept: Pick<ConceptMatchInput, "sourceTerm" | "match">,
  project?: TermMatchingSettings,
): ResolvedMatchOptions {
  const prefixes = (project?.prefixes ?? []).filter((p) => p.length > 0)
  const suffixes = (project?.suffixes ?? []).filter((s) => s.length > 0)
  const hasInventory = prefixes.length > 0 || suffixes.length > 0

  const foldMarks =
    concept.match?.foldMarks ??
    project?.foldMarksDefault ??
    hasFoldableDiacritics(concept.sourceTerm)

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
 * Validate untrusted match options (a TBX note, a pasted JSON blob) into a
 * TermMatchOptions. Field types are checked, not assumed: `resolveMatchOptions`
 * calls `.map` on `forms`/`excludedForms`, so a string where an array belongs
 * would throw at match time, far from the import that accepted it. Invalid
 * fields are dropped rather than rejecting the whole import — a bad note must
 * not cost the user the concept. Returns undefined when nothing valid remains.
 */
export function coerceMatchOptions(raw: unknown): TermMatchOptions | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined
  const rec = raw as Record<string, unknown>
  const out: TermMatchOptions = {}
  if (typeof rec.foldMarks === "boolean") out.foldMarks = rec.foldMarks
  if (typeof rec.affixes === "boolean") out.affixes = rec.affixes
  for (const key of ["forms", "excludedForms"] as const) {
    const value = rec[key]
    if (!Array.isArray(value)) continue
    const strings = value.filter((v): v is string => typeof v === "string")
    if (strings.length > 0) out[key] = strings
  }
  return Object.keys(out).length > 0 ? out : undefined
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
