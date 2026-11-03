// AQU-2342: one place for "how the AI should translate this project".
//
// Before this module the answer lived in four places that different drafting
// paths read inconsistently: the copilot's editable system prompt
// (`settings.systemPrompt`), the translation brief's L1 summary
// (`settings.translationBrief`), Living Memory instruction entries
// (`settings.livingMemoryEntries`, read by no prompt at all) and the agent's
// legacy free-text brief (`project_briefs`). Every drafting path — the editor's
// copilot, the prompt preview, the agent chat, the agent's draft tool and
// Autopilot — now reads ONE string, `settings.translationInstructions`, through
// `resolveTranslationInstructions`, and injects it with `instructionsPromptBlock`
// at the same position: right after the path's fixed role text, before rules,
// terms and examples.
//
// A project that never wrote the new key is migrated ON READ: the old sources
// are composed into one de-duplicated text. Phase 2 folded in the rest of the
// standing guidance: Living Memory "standard" entries, the Autopilot decision
// log (`settings.projectFacts`, all but Language-profile keys — those are data
// the Bible data checks read, see docs/AI-GUIDANCE.md) and the agent's
// approved `decisions/` memories. Nothing is written back
// until a maintainer saves the Instructions editor, which stores the (possibly
// edited) migrated text under the new key — from then on the old sources are
// ignored by every prompt.
//
// Dependency-free so BOTH workers and the SPA (relative import, see
// src/lib/completion/prompt-build.ts) can use it.

import { BRIEF_FIELD_SPECS, readBriefFromSettings, type TranslationBriefRecord } from './brief'
import { readProjectFacts, type FactScope, type ProjectFact } from './project-facts'

/** The settings key the instructions live under. */
export const TRANSLATION_INSTRUCTIONS_KEY = 'translationInstructions'

/** Ceiling on the stored text. The block rides in every drafting prompt, so this
 *  is a token budget (~2k tokens), not a display nicety. */
export const TRANSLATION_INSTRUCTIONS_MAX_CHARS = 8000

/** Heading of the prompt block every drafting path injects. */
export const INSTRUCTIONS_BLOCK_HEADING = 'Project instructions (follow these):'

/**
 * The copilot's fixed role/system template. `{sourceLanguage}` and
 * `{targetLanguage}` are substituted at prompt-build time. Lives here (and is
 * re-exported by src/lib/completion/prompt-build.ts) so the migrate-on-read
 * path can tell a stored default from a hand-customized prompt.
 */
export const DEFAULT_SYSTEM_PROMPT =
  'You are a translation assistant completing a project that translates from {sourceLanguage} into {targetLanguage}.\n\n' +
  "The translation examples the user provides are your PRIMARY source of truth. Treat every observable convention in them as binding: reproduce the project's wording, spelling, tone, register, punctuation, formatting, and style rather than substituting defaults associated with the {targetLanguage} label. This may be an ultra-low-resource language, so follow the project's own evidence above general knowledge.\n\n" +
  'Always translate from {sourceLanguage} to {targetLanguage}, relying strictly on the reference data and context provided. The language may be an ultra-low-resource language, so it is critical to follow the patterns and style of the provided reference data closely.\n\n' +
  'To produce the translation, follow these steps:\n' +
  '1. Analyze the provided reference data to understand the translation patterns and style.\n' +
  '2. Complete the translation of the given source line or passage.\n' +
  '3. Ensure your translation is consistent with the existing partial translation and surrounding context.\n' +
  '4. Pay careful attention to the provided reference data — match its terminology, register, and conventions as closely as possible.\n' +
  '5. Translate only into {targetLanguage}.\n' +
  '6. When unsure, err on the side of literalness and stay consistent with the examples.\n' +
  '7. Preserve the line breaks and any inline formatting present in the source.\n\n' +
  'Output rules (strictly enforced):\n' +
  '- Output ONLY the {targetLanguage} translation of the final source line — nothing else.\n' +
  '- No commentary, explanations, labels, headers, markdown, language names, or restated source text. Just the translated text.'

/**
 * Lines of EARLIER default templates. A project that saved its prompt while one
 * of these was the default still carries it verbatim; those lines are the
 * template, not anything the team wrote, so migration strips them too.
 */
const LEGACY_DEFAULT_LINES: readonly string[] = [
  'You are a translation assistant. Translate from {sourceLanguage} to {targetLanguage}. Output ONLY the translation, nothing else. Do not include explanations, notes, or the original text.',
  'You are translating a project from {sourceLanguage} into {targetLanguage}.',
  'The translation examples the user provides are your PRIMARY source of truth. They show the exact terminology, tone, register, punctuation, and stylistic conventions this specific project uses. Study them and reproduce those patterns precisely. This may be an ultra-low-resource language, so do not fall back on general knowledge of {targetLanguage} — follow the project\'s own patterns above all else.',
  'Match the terminology, style, and conventions of the provided examples as closely as possible.',
  'When unsure, prefer a literal translation that stays consistent with the examples.',
  'Preserve the line breaks and any inline formatting present in the source.',
  'No commentary, explanations, labels, headers, markdown, language names, or restated source text. Just the translated text.',
  'Output ONLY the {targetLanguage} translation of the final source line — nothing else.',
]

/** One template line as compared: list markers dropped, whitespace collapsed,
 *  case folded. */
function normalizeTemplateLine(line: string): string {
  return line
    .trim()
    .replace(/^(?:\d+[.)]|[-*•])\s+/, '')
    .replace(/\s+/g, ' ')
    .toLowerCase()
}

const DEFAULT_TEMPLATE_LINES: ReadonlySet<string> = new Set(
  [...DEFAULT_SYSTEM_PROMPT.split('\n'), ...LEGACY_DEFAULT_LINES]
    .map(normalizeTemplateLine)
    .filter(Boolean),
)

/**
 * What the team actually wrote in a stored system prompt: every line of the
 * default template (current or earlier) removed, blank runs collapsed. A stored
 * prompt that is only the template — or empty — yields "".
 */
export function customSystemPromptText(prompt: string | null | undefined): string {
  const raw = (prompt ?? '').replace(/\r\n?/g, '\n')
  if (!raw.trim()) return ''
  const kept = raw.split('\n').filter((line) => {
    const n = normalizeTemplateLine(line)
    return n === '' || !DEFAULT_TEMPLATE_LINES.has(n)
  })
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * The brief as instructions: its L1 summary when one was rendered, else its
 * filled sections and notes as short "Heading: answer" prose.
 */
export function briefInstructionsText(brief: TranslationBriefRecord | null): string {
  if (!brief) return ''
  const summary = (brief.l1Summary ?? '').trim()
  if (summary) return summary
  const lines: string[] = []
  for (const field of BRIEF_FIELD_SPECS) {
    const answer = (brief.parameters[field.id] ?? '').trim()
    if (answer) lines.push(`${field.heading}: ${answer}`)
  }
  const notes = brief.freeformNotes.trim()
  if (notes) lines.push(notes)
  return lines.join('\n')
}

/** Text of each Living Memory "instruction" and "standard" entry, in stored
 *  order. Both kinds were standing guidance; neither reached a prompt before
 *  AQU-2342. */
function livingMemoryInstructionTexts(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue
    const { kind, text } = entry as { kind?: unknown; text?: unknown }
    if ((kind === 'instruction' || kind === 'standard') && typeof text === 'string' && text.trim()) {
      out.push(text.trim())
    }
  }
  return out
}

function factScopeLabel(scope: FactScope): string {
  const parts: string[] = []
  if (scope.passage) parts.push(`${scope.passage.from}–${scope.passage.to}`)
  else if (scope.book) parts.push(scope.book)
  if (scope.entity) parts.push(`about ${scope.entity}`)
  return parts.length > 0 ? ` (${parts.join('; ')})` : ''
}

/**
 * One decision-log fact as an instructions line: "- key: value (scope) — note".
 * Autopilot's "Project decisions" block used the same parts; the line is now
 * prose the team can read and edit in the Instructions box.
 */
export function projectFactInstructionLine(
  fact: Pick<ProjectFact, 'key' | 'value' | 'scope'> & { note?: string },
): string {
  const note = fact.note?.trim() ? ` — ${fact.note.trim()}` : ''
  return `- ${fact.key}: ${fact.value.trim()}${factScopeLabel(fact.scope ?? {})}${note}`
}

/** The decision log as one instructions paragraph, oldest decision first (the
 *  order the team made them), or "" when there are none. Language-profile
 *  answers are never stored as facts, so none appear here. */
export function projectFactsInstructionsText(raw: unknown): string {
  const facts = readProjectFacts(raw).sort((a, b) => a.at.localeCompare(b.at))
  if (facts.length === 0) return ''
  return ['Project decisions:', ...facts.map(projectFactInstructionLine)].join('\n')
}

/**
 * The guidance in an agent `decisions/` memory. AddDecision renders
 * "Decision — X" + blank line + X; that summary line is dropped when the body
 * repeats it. Anything else (a propose_memory decision) is used as written.
 */
export function decisionMemoryText(content: string): string {
  const text = content.replace(/\r\n?/g, '\n').trim()
  const [first = '', ...rest] = text.split('\n')
  const summary = /^Decision\s+[—-]\s*(.*)$/.exec(first.trim())
  if (!summary) return text
  const body = rest.join('\n').trim()
  return body || summary[1].trim()
}

/** Comparison form for de-duplication: whitespace collapsed, case folded. */
function dedupeKey(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase()
}

/**
 * Join parts in order, skipping any part that is blank, equal to, or contained
 * in one already kept. A part that CONTAINS an earlier one replaces it in that
 * earlier position, so the fuller wording wins without reordering.
 */
export function composeDeduplicated(parts: readonly string[]): string {
  const kept: string[] = []
  for (const part of parts) {
    const text = part.trim()
    const key = dedupeKey(text)
    if (!key) continue
    if (kept.some((k) => dedupeKey(k).includes(key))) continue
    const swallowed = kept.findIndex((k) => key.includes(dedupeKey(k)))
    if (swallowed >= 0) {
      kept[swallowed] = text
      // Any other earlier part this one also contains is now redundant.
      for (let i = kept.length - 1; i > swallowed; i--) {
        if (key.includes(dedupeKey(kept[i]))) kept.splice(i, 1)
      }
      continue
    }
    kept.push(text)
  }
  return kept.join('\n\n')
}

/** Old sources a caller can supply that are not in the settings blob. */
export interface LegacyInstructionSources {
  /** Server-held sources the browser cannot read itself, already composed:
   *  the agent's legacy free-text brief (`project_briefs.content`) and its
   *  approved `decisions/` memories (see readLegacyServerInstructions). */
  projectBriefText?: string | null
}

/**
 * The project's own stored instructions, or null when it never wrote any.
 * A stored string is authoritative even when blank: a maintainer who cleared
 * the field meant "no instructions", and the legacy sources must not come back.
 */
export function storedTranslationInstructions(
  settings: Record<string, unknown> | null | undefined,
): string | null {
  const raw = settings?.[TRANSLATION_INSTRUCTIONS_KEY]
  return typeof raw === 'string' ? raw.trim() : null
}

/**
 * THE project instructions every drafting prompt reads.
 *
 * `translationInstructions` when the key is stored (a blank string included —
 * that is an explicit "none"). Otherwise (migrate-on-read) the old
 * sources composed and de-duplicated, in this order: the brief (summary, or its
 * sections as prose), the hand-written part of a customized system prompt,
 * Living Memory instruction and standard entries, the decision log
 * (`projectFacts`), then the server-held sources (the agent's legacy project
 * brief and approved `decisions/` memories). Capped
 * at TRANSLATION_INSTRUCTIONS_MAX_CHARS. "" when the project has none.
 */
export function resolveTranslationInstructions(
  settings: Record<string, unknown> | null | undefined,
  legacy?: LegacyInstructionSources,
): string {
  const stored = storedTranslationInstructions(settings)
  if (stored !== null) return stored.slice(0, TRANSLATION_INSTRUCTIONS_MAX_CHARS)
  const s = settings ?? {}
  const systemPrompt = typeof s.systemPrompt === 'string' ? s.systemPrompt : ''
  const composed = composeDeduplicated([
    briefInstructionsText(readBriefFromSettings(s)),
    customSystemPromptText(systemPrompt),
    ...livingMemoryInstructionTexts(s.livingMemoryEntries),
    projectFactsInstructionsText(s.projectFacts),
    legacy?.projectBriefText ?? '',
  ])
  return composed.slice(0, TRANSLATION_INSTRUCTIONS_MAX_CHARS).trim()
}

/** The titled block a drafting prompt carries, or "" when there is no text. */
export function instructionsPromptBlock(text: string | null | undefined): string {
  const body = (text ?? '').trim()
  if (!body) return ''
  return `${INSTRUCTIONS_BLOCK_HEADING}\n${body}`
}

/** PatchSettings validator: null when the value may be stored. */
export function translationInstructionsProblem(value: unknown): string | null {
  if (typeof value !== 'string') return 'not a string'
  if (value.length > TRANSLATION_INSTRUCTIONS_MAX_CHARS) {
    return `longer than ${TRANSLATION_INSTRUCTIONS_MAX_CHARS} characters`
  }
  return null
}

/** Why a line could not be appended. */
export type AppendInstructionRejection = 'instructions-full'

export type AppendInstructionResult =
  | { ok: true; text: string; changed: boolean }
  | { ok: false; reason: AppendInstructionRejection }

/**
 * `current` with `line` appended as its own paragraph line. A line the text
 * already holds (whitespace/case folded) is not added twice (`changed: false`).
 * Refused when the result would pass TRANSLATION_INSTRUCTIONS_MAX_CHARS: the
 * block rides in every prompt, so a full box is the team's to edit, never
 * silently truncated.
 */
export function appendInstructionLine(current: string, line: string): AppendInstructionResult {
  const base = current.trim()
  const add = line.trim()
  if (!add || dedupeKey(base).includes(dedupeKey(add))) return { ok: true, text: base, changed: false }
  const text = base ? `${base}\n${add}` : add
  if (text.length > TRANSLATION_INSTRUCTIONS_MAX_CHARS) return { ok: false, reason: 'instructions-full' }
  return { ok: true, text, changed: true }
}
