// The "Project decisions" lines of the draft prompt (AQU-1691).
//
// HARD constraints beside the key terms: the project's Language profile, and
// the decision-log facts that apply to THIS span (db/shared/project-facts.ts).
// Both are durable. An answer reaches every later draft in every run and file,
// unlike steering, which autopilot consumes after one wave.
//
// Clipped, so a long decision log cannot crowd the scene out of the prompt.
// The per-cell Bible facts line (speakers, participants) is AQU-1690's, not
// this block's.

import {
  LANGUAGE_PROFILE_SLOTS,
  type LanguageProfile,
  type LanguageProfileSlot,
} from "../../../../db/shared/language-profile"
import { factsInScope, type FactScope, type ProjectFact } from "../../../../db/shared/project-facts"

/** Ceiling on decision-log facts in one prompt. The most specific facts come first, so the cut falls on the broadest. */
export const MAX_FACTS_PER_SPAN = 24
const FACT_VALUE_MAX_CHARS = 200
const FACT_NOTE_MAX_CHARS = 160
const PROFILE_LINE_MAX_CHARS = 300

/** English, for the model: the prompt is not UI. */
const SLOT_LABELS: Readonly<Record<LanguageProfileSlot, string>> = {
  quoteMarks: "Quotation marks by level",
  questionMarkers: "Question markers besides a question mark",
  pronouns: "Pronoun distinctions",
  negators: "Negators",
  numberWords: "Number words",
  speechVerbs: "Speech verbs for quote margins",
  kinTerms: "Kin terms",
  divineNames: "Divine names",
  measures: "Measures (convert, transliterate or mixed)",
  textualVariants: "Textual variants",
  headings: "Section headings",
}

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value
}

function scopeLabel(scope: FactScope): string {
  const parts: string[] = []
  if (scope.passage) parts.push(`${scope.passage.from}–${scope.passage.to}`)
  else if (scope.book) parts.push(scope.book)
  if (scope.entity) parts.push(`about ${scope.entity}`)
  return parts.length > 0 ? ` (${parts.join("; ")})` : ""
}

/**
 * One line per filled Language-profile slot, then one per decision-log fact in
 * scope for a span whose cells carry `refs` (canonical refs, e.g. "ACT 16:10").
 * Empty when the project has decided nothing.
 */
export function projectDecisionLines(
  facts: readonly ProjectFact[],
  profile: LanguageProfile,
  refs: readonly (string | null | undefined)[],
): string[] {
  const lines: string[] = []
  for (const slot of LANGUAGE_PROFILE_SLOTS) {
    const value = profile[slot]
    if (value === undefined) continue
    lines.push(`- ${SLOT_LABELS[slot]}: ${clip(JSON.stringify(value), PROFILE_LINE_MAX_CHARS)}`)
  }
  for (const fact of factsInScope(facts, refs).slice(0, MAX_FACTS_PER_SPAN)) {
    const note = fact.note ? ` — ${clip(fact.note, FACT_NOTE_MAX_CHARS)}` : ""
    lines.push(`- ${fact.key} = ${JSON.stringify(clip(fact.value, FACT_VALUE_MAX_CHARS))}${scopeLabel(fact.scope)}${note}`)
  }
  return lines
}
