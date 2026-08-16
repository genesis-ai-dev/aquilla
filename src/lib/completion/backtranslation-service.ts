import { complete } from "./completion-service"
import type { CompletionSettings } from "@/lib/parsers/types"
import type { FrontierSession } from "@/lib/frontier/types"
import type { Concept } from "@/lib/terminology/types"

export const BACKTRANSLATION_SYSTEM_PROMPT = `You are a backtranslation assistant. You will be given text in {targetLanguage} that is a translation. Your job is to provide a word-for-word, literal translation of that text BACK into {sourceLanguage}.

A backtranslation preserves the exact words and structure of the translated text, even if it sounds unnatural. For example, if the translation says "house of him", the backtranslation should say "house of him" — not "his house". This shows exactly what the translation says at a word level.

The purpose is verification: translators use backtranslations to confirm their translation conveys the intended meaning and doesn't drift.

Return ONLY the backtranslation text. No explanations, no markdown, no notes.`

interface ChatMessage { role: "system" | "user" | "assistant"; content: string }

/**
 * A terminology hint: a source headword and its preferred target rendering(s).
 * When the source term is known to occur in the cell, these renderings are the
 * controlled-vocabulary equivalents the translator chose, so the literal
 * back-translation should surface those source headwords for those renderings.
 */
export interface TerminologyHint {
  sourceTerm: string
  preferred: string[]
}

interface BuildOptions {
  sourceLanguage: string
  targetLanguage: string
  targetText: string
  examples: { target: string; backtranslation: string }[]
  /**
   * Optional terminology guidance. Each hint maps a source headword to its
   * preferred target rendering(s); they are injected into the system prompt as
   * a controlled-vocabulary glossary so the LLM produces the headword when it
   * sees the corresponding rendering. Additive — omit for unchanged behavior.
   */
  terminologyHints?: TerminologyHint[]
}

/**
 * Derive terminology hints from a set of Concepts and the cell's source text.
 *
 * A concept contributes a hint only when its (normalized, case-insensitive)
 * source headword appears in `sourceText` — so we only seed renderings that are
 * actually relevant to this cell. Only `preferred` renderings are surfaced;
 * `admitted` / `forbidden` are intentionally excluded from positive guidance.
 * Deprecated/draft concepts are skipped (active vocabulary only).
 */
export function deriveTerminologyHints(
  concepts: Concept[] | undefined,
  sourceText: string | undefined,
): TerminologyHint[] {
  if (!concepts || concepts.length === 0 || !sourceText) return []
  const haystack = sourceText.toLowerCase()
  const hints: TerminologyHint[] = []
  for (const concept of concepts) {
    if (concept.status !== "active") continue
    const term = concept.sourceTerm.trim()
    if (!term || !haystack.includes(term.toLowerCase())) continue
    const preferred = concept.renderings
      .filter((r) => r.status === "preferred")
      .map((r) => r.rendering.trim())
      .filter(Boolean)
    if (preferred.length === 0) continue
    hints.push({ sourceTerm: term, preferred })
  }
  return hints
}

function buildTerminologyGuidance(hints: TerminologyHint[]): string {
  const lines = hints
    .filter((h) => h.sourceTerm.trim() && h.preferred.length > 0)
    .map((h) => `- "${h.preferred.join('" / "')}" → ${h.sourceTerm}`)
  if (lines.length === 0) return ""
  return [
    "",
    "",
    "Controlled-vocabulary glossary. The translation uses these established target renderings for specific source terms. When you see one of these renderings, back-translate it to the indicated source term:",
    ...lines,
  ].join("\n")
}

/**
 * AQU-848: what to say when the project carries no source language. Callers
 * must pass the *configured* source language through verbatim; when there is
 * none, the prompt stays language-neutral rather than naming a language the
 * project never chose (it used to default to English, which produced English
 * back-translations for low-resource projects).
 */
const UNSET_SOURCE_LANGUAGE = "the source language"

export function buildBacktranslationPrompt(options: BuildOptions): ChatMessage[] {
  let systemContent = BACKTRANSLATION_SYSTEM_PROMPT
    .replace(/\{sourceLanguage\}/g, options.sourceLanguage.trim() || UNSET_SOURCE_LANGUAGE)
    .replace(/\{targetLanguage\}/g, options.targetLanguage)

  if (options.terminologyHints && options.terminologyHints.length > 0) {
    systemContent += buildTerminologyGuidance(options.terminologyHints)
  }

  let userContent = ""
  for (const ex of options.examples) {
    userContent += `Text: ${ex.target}\nBacktranslation: ${ex.backtranslation}\n\n`
  }
  userContent += `Text: ${options.targetText}\nBacktranslation:`

  return [
    { role: "system", content: systemContent },
    { role: "user", content: userContent.trim() },
  ]
}

export interface GenerateBacktranslationOptions extends BuildOptions {
  settings: CompletionSettings
  session: FrontierSession | null
  onChunk?: (text: string) => void
  /**
   * Optional. Active terminology Concepts for the project. When supplied
   * together with `sourceText`, the relevant preferred renderings are derived
   * and injected as glossary guidance. Use this OR pass `terminologyHints`
   * directly (inherited from BuildOptions); explicit hints take precedence.
   */
  concepts?: Concept[]
  /** The cell's source text, used to derive which concepts are relevant. */
  sourceText?: string
}

// SWARM-TODO(btseed-glue): ProjectWorkspace's BT-generation call site (the
// generateBacktranslation invocation feeding the EditorTable BT tab) does not
// yet pass terminology. The glue wave should pass the project's active
// Concept[] as `concepts` and the cell's source string as `sourceText`; this
// service derives the relevant preferred-rendering hints internally. No change
// to the existing call is required for unchanged behavior (both fields are
// optional). See TRACES (btseed-glue). FORBIDDEN to edit ProjectWorkspace here.
export async function generateBacktranslation(options: GenerateBacktranslationOptions): Promise<string> {
  // Explicit hints win; otherwise derive from concepts + sourceText if given.
  const terminologyHints = options.terminologyHints
    ?? deriveTerminologyHints(options.concepts, options.sourceText)

  const messages = buildBacktranslationPrompt({
    sourceLanguage: options.sourceLanguage,
    targetLanguage: options.targetLanguage,
    targetText: options.targetText,
    examples: options.examples,
    terminologyHints,
  })

  // Backtranslation uses a lower temperature for literal output.
  return complete({
    settings: { ...options.settings, temperature: 0.1 },
    session: options.session,
    messages,
    stream: Boolean(options.onChunk),
    onChunk: options.onChunk,
  })
}
