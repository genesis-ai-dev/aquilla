/**
 * Translation context and its revision (spec §4.3).
 *
 * A unit's translation is a function of (source, context, policy). When an
 * org decision changes — a new glossary term, a retroactive style rule — only
 * the units that decision is relevant to get a new context revision, and only
 * those are retranslated. A term about "covenant" does not invalidate a
 * paragraph about shipping costs.
 */
import { hashValue } from "./hash.ts"
import type { Correction, LedgerState, Rule, Term } from "./ledger.ts"
import { acceptedCorrections, activeRules, activeTerms } from "./ledger.ts"

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
const isSpaceDelimited = (s: string): boolean => /^[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\p{N}\s'’-]+$/u.test(s)

/** Whole-word, case-insensitive match for space-delimited scripts; substring match otherwise (CJK, Thai…). */
export const containsTerm = (text: string, term: string): boolean => {
  if (term.trim() === "") return false
  if (!isSpaceDelimited(term)) return text.toLowerCase().includes(term.toLowerCase())
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(term)}(?![\\p{L}\\p{N}])`, "iu").test(text)
}

/** Replace whole-word occurrences, preserving a leading capital where the original had one. */
export const replaceTerm = (text: string, from: string, to: string): string => {
  if (!isSpaceDelimited(from)) return text.split(from).join(to)
  return text.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(from)}(?![\\p{L}\\p{N}])`, "giu"), (m) =>
    m[0] && m[0] !== m[0].toLowerCase() && to[0] ? to[0].toUpperCase() + to.slice(1) : to,
  )
}

export interface UnitContext {
  readonly terms: Term[]
  readonly rules: Rule[]
  readonly corrections: Correction[]
  /** Changes when a decision relevant to this unit changes. */
  readonly contextRevision: string
  /** Changes when any rule for the locale changes (recorded, but only retroactive rules invalidate). */
  readonly policyRevision: string
}

export const unitContext = (state: LedgerState, locale: string, plainSource: string): UnitContext => {
  const terms = activeTerms(state, locale)
    .filter((t) => containsTerm(plainSource, t.source))
    .sort((a, b) => (a.id < b.id ? -1 : 1))
  const rules = activeRules(state, locale).sort((a, b) => (a.id < b.id ? -1 : 1))
  const corrections = acceptedCorrections(state, locale).sort((a, b) => (a.id < b.id ? -1 : 1))
  return {
    terms,
    rules,
    corrections,
    contextRevision: hashValue({
      terms: terms.map((t) => [t.id, t.source, t.target]),
      rules: rules.filter((r) => r.retroactive).map((r) => [r.id, r.text]),
    }),
    policyRevision: hashValue(rules.map((r) => [r.id, r.text])),
  }
}
