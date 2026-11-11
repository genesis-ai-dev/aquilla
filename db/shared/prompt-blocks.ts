// AQU-2342 phase 2: the guidance blocks every drafting prompt carries, built
// by ONE set of functions so the five drafting paths cannot drift:
//
//   copilot (src/lib/completion/prompt-build.ts + completion-service.ts),
//   prompt preview (sync-worker/src/external/prompt-preview.ts — calls the
//     copilot builders), agent chat (auth-worker/src/lib/agent/schema-card.ts),
//   agent draft tool / DraftCells (auth-worker/src/lib/agent/tools/draft.ts),
//   Autopilot (auth-worker/src/lib/contextual/draft.ts).
//
// The four user-facing concepts (docs/AI-GUIDANCE.md) map to blocks:
//   Instructions → instructionsPromptBlock (./translation-instructions.ts)
//   Checks       → checksHintBlock: project / lane / org rules, the style
//                  rules in force here, and the Language-profile slots the
//                  Bible data checks read. Verified after drafting; this is the
//                  hint so the draft is right the first time.
//   Terminology  → terminologyBlock: only the terms whose source form occurs
//                  in the text being drafted (the matcher is the caller's —
//                  every path uses the termbase compiler's source pattern).
//   Examples     → validated pairs; each path keeps its own rendering (chat
//                  few-shot turns, [E#]-cited lines, JSON pairs) because the
//                  label scheme is part of that path's task contract.
//
// And ONE order, `PROMPT_SECTION_ORDER`, assembled by `assemblePromptSections`:
// role → instructions → checks → terminology → examples → context → this run's
// directions, then the path's fixed output contract. A path that renders
// examples/context in its user message keeps that order across the two
// messages (system blocks first, then the user message's examples/context).
//
// Dependency-free, relative imports only: both workers and the SPA import it.

import { instructionsPromptBlock } from './translation-instructions'
import { LANGUAGE_PROFILE_SLOTS, type LanguageProfile, type LanguageProfileSlot } from './language-profile'

// ── Checks ──────────────────────────────────────────────────────────────────

export const CHECKS_BLOCK_HEADING =
  'Checks (verified automatically after drafting — the draft must pass each one):'

/** One check as the hint reads it. Structural: the SPA's `TranslationRule`,
 *  the workers' `LintRule` and a style rule's instruction all fit. */
export interface CheckHint {
  name?: string
  /** A sentence saying what the check requires. Preferred over the pattern. */
  description?: string
  enabled?: boolean
  check?:
    | { type: 'source-requires-target'; sourcePattern: string; targetPattern: string }
    | { type: 'target-forbids'; targetPattern: string }
    | { type: 'source-target-match'; pattern: string }
    | { type: string; [key: string]: unknown }
  /** Terminology rules carry this (or an id starting `term:`): they belong to
   *  the Terminology block, never the checks hint. */
  term?: unknown
  id?: string
}

/** Longest single check line, so one verbose rule cannot crowd the prompt. */
export const MAX_CHECK_LINE_CHARS = 240
/** Most checks one prompt lists. Ordered as given (most specific first). */
export const MAX_CHECK_HINTS = 40

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * One rule as a hint line, or "" when it says nothing a model can use.
 * The description wins: it is the sentence the team wrote for what the rule
 * requires. A rule without one falls back to its pattern shape (the copilot's
 * old wording). A built-in check contributes nothing — its requirement is
 * algorithmic, and its language data rides in the profile lines.
 */
export function checkHintLine(rule: CheckHint): string {
  if (rule.enabled === false) return ''
  if (rule.term !== undefined || rule.id?.startsWith('term:')) return ''
  // Built-in checks are algorithmic (spacing, numbers, punctuation…): their
  // descriptions are generic, and the data they verify against rides in the
  // Language-profile lines instead.
  if (rule.check?.type === 'builtin') return ''
  const description = rule.description?.trim()
  if (description) return `- ${clip(description, MAX_CHECK_LINE_CHARS)}`
  const check = rule.check
  if (check?.type === 'source-requires-target') {
    return `- When the source contains "${str(check.sourcePattern)}", the translation must include "${str(check.targetPattern)}".`
  }
  if (check?.type === 'target-forbids') return `- Do NOT use "${str(check.targetPattern)}" in the translation.`
  if (check?.type === 'source-target-match') {
    return `- The pattern "${str(check.pattern)}" must appear in the translation when present in the source.`
  }
  return ''
}

/** English, for the model: the prompt is not UI. */
const PROFILE_SLOT_LABELS: Readonly<Record<LanguageProfileSlot, string>> = {
  quoteMarks: 'Quotation marks by level',
  punctuation: 'Terminal and clause punctuation',
  questionMarkers: 'Question markers besides a question mark',
  pronouns: 'Pronoun distinctions',
  negators: 'Negators',
  numberWords: 'Number words',
  numberFormat: 'Number separators (grouping and decimal)',
  speechVerbs: 'Speech verbs for quote margins',
  kinTerms: 'Kin terms',
  divineNames: 'Divine names',
  measures: 'Measures (convert, transliterate or mixed)',
  textualVariants: 'Textual variants',
  headings: 'Section headings',
}

const PROFILE_LINE_MAX_CHARS = 300

/** One line per filled Language-profile slot (the data the Bible data checks
 *  verify against). Empty when nothing is filled. */
export function languageProfileHintLines(profile: LanguageProfile | null | undefined): string[] {
  if (!profile) return []
  const lines: string[] = []
  for (const slot of LANGUAGE_PROFILE_SLOTS) {
    const value = profile[slot]
    if (value === undefined) continue
    lines.push(`- ${PROFILE_SLOT_LABELS[slot]}: ${clip(JSON.stringify(value), PROFILE_LINE_MAX_CHARS)}`)
  }
  return lines
}

export interface ChecksHintInput {
  /** Project (incl. lane-scoped, already narrowed to the lane) and org rules,
   *  most specific first. Terminology rules in here are skipped. */
  rules?: readonly CheckHint[]
  /** The style-rule instructions in force for the text being drafted. */
  styleInstructions?: readonly string[]
  /** The Language profile — data the Bible data checks verify. */
  languageProfile?: LanguageProfile | null
}

/** THE checks hint, or "" when the project has no check that can be hinted. */
export function checksHintBlock(input: ChecksHintInput): string {
  const lines: string[] = []
  const seen = new Set<string>()
  const add = (line: string) => {
    const key = line.replace(/\s+/g, ' ').trim().toLowerCase()
    if (!line || seen.has(key) || lines.length >= MAX_CHECK_HINTS) return
    seen.add(key)
    lines.push(line)
  }
  for (const rule of input.rules ?? []) add(checkHintLine(rule))
  for (const raw of input.styleInstructions ?? []) {
    const instruction = raw.trim()
    if (instruction) add(`- ${clip(instruction, MAX_CHECK_LINE_CHARS)}`)
  }
  for (const line of languageProfileHintLines(input.languageProfile)) add(line)
  if (lines.length === 0) return ''
  return `${CHECKS_BLOCK_HEADING}\n${lines.join('\n')}`
}

// ── Terminology ─────────────────────────────────────────────────────────────

export const TERMINOLOGY_BLOCK_HEADING =
  'Terminology for this text (use an approved rendering for each term; never a forbidden one):'

/** Longest term note carried into a prompt. Notes explain a choice; the
 *  renderings are the constraint, so a note is clipped rather than dropped. */
export const MAX_TERM_NOTE_CHARS = 160

/** One matched glossary concept as a prompt line reads it. */
export interface TermHint {
  sourceTerm: string
  /** Preferred rendering first, then admitted ones. */
  approved: readonly string[]
  forbidden: readonly string[]
  notes?: string
}

/** One term line, regex-free; "" for a concept with nothing to say. */
export function terminologyLine(term: TermHint): string {
  const parts: string[] = []
  const [preferred, ...alternates] = term.approved.filter(Boolean)
  if (preferred) {
    parts.push(
      alternates.length
        ? `"${term.sourceTerm}" → "${preferred}" (also acceptable: ${alternates.map((r) => `"${r}"`).join(', ')})`
        : `"${term.sourceTerm}" → "${preferred}"`,
    )
  }
  const forbidden = term.forbidden.filter(Boolean)
  if (forbidden.length) {
    const list = forbidden.map((r) => `"${r}"`).join(', ')
    parts.push(preferred ? `Do NOT use ${list}` : `"${term.sourceTerm}": Do NOT use ${list}`)
  }
  if (parts.length === 0) return ''
  const note = term.notes?.trim() ? ` Note: ${clip(term.notes.trim(), MAX_TERM_NOTE_CHARS)}` : ''
  return `- ${parts.join('. ')}.${note}`
}

/** THE terminology block for already-matched terms, or "" when none. */
export function terminologyBlock(terms: readonly TermHint[]): string {
  const lines = terms.map(terminologyLine).filter(Boolean)
  if (lines.length === 0) return ''
  return `${TERMINOLOGY_BLOCK_HEADING}\n${lines.join('\n')}`
}

// ── Run directions ──────────────────────────────────────────────────────────

export const DIRECTIONS_BLOCK_HEADING =
  "This run's directions (they override the project instructions for this run only — never the checks or terminology):"

/** Per-run directions (Autopilot steering, the draft tool's `instructions`
 *  arg). Transient: never stored as guidance. "" when none. */
export function runDirectionsBlock(directions: readonly string[] | string | null | undefined): string {
  const list = (typeof directions === 'string' ? [directions] : directions ?? [])
    .map((d) => d.trim())
    .filter(Boolean)
  if (list.length === 0) return ''
  return `${DIRECTIONS_BLOCK_HEADING}\n${list.map((d) => `- ${d}`).join('\n')}`
}

// ── Assembly ────────────────────────────────────────────────────────────────

/** The canonical section order. `output` is the path's fixed output contract
 *  (strict JSON, "translation only"), which closes the prompt. */
export const PROMPT_SECTION_ORDER = [
  'role',
  'instructions',
  'checks',
  'terminology',
  'examples',
  'context',
  'directions',
  'output',
] as const

export type PromptSection = (typeof PROMPT_SECTION_ORDER)[number]

export type PromptSections = Partial<Record<PromptSection, string | null | undefined>>

/** Join the given sections in PROMPT_SECTION_ORDER, blank ones skipped. */
export function assemblePromptSections(sections: PromptSections): string {
  return PROMPT_SECTION_ORDER.map((name) => (sections[name] ?? '').trim())
    .filter(Boolean)
    .join('\n\n')
}

export interface GuidanceInput extends ChecksHintInput {
  /** The project's resolved instructions (resolveTranslationInstructions). */
  instructions?: string | null
  /** Terms already matched against the text being drafted. */
  terms?: readonly TermHint[]
}

/** The three standing-guidance sections, built the one way every path uses. */
export function guidanceSections(input: GuidanceInput): Pick<PromptSections, 'instructions' | 'checks' | 'terminology'> {
  return {
    instructions: instructionsPromptBlock(input.instructions),
    checks: checksHintBlock(input),
    terminology: terminologyBlock(input.terms ?? []),
  }
}
