// Worker-safe core of copilot prompt assembly (AQU-1230).
//
// These are the functions that turn project configuration + retrieved evidence
// into the exact `ChatMessage[]` the copilot sends. They used to live in
// completion-service.ts, which cannot be imported outside the browser: that
// module reads `import.meta.env` at module load and `window.location` in
// `complete()`, and transitively pulls in localStorage-backed stores and the
// i18n catalogs.
//
// They were split out so the Agent API's effective-prompt preview
// (sync-worker/src/external/prompt-preview.ts) can call the SAME code the
// editor calls, rather than re-deriving the assembly server-side and drifting
// from it. That is the whole point of the preview — a preview that is only
// "roughly" what the copilot sends is worse than none.
//
// Constraints for anything added here (same contract as
// src/lib/parsers/parse-text-formats.ts):
//   - NO `@/` path aliases, transitively — sync-worker's tsconfig has no path
//     mapping, so an alias anywhere in the import graph breaks `npm run
//     type-check` there.
//   - NO DOM, no `import.meta.env`, no storage access, no i18n.
//   - Structural parameter types only (see PromptRule): the app's nominal
//     `TranslationRule` satisfies them, and the worker can build them from SQL
//     rows without importing the SPA's type graph.
//
// completion-service.ts re-exports everything here, so every existing call
// site and test keeps importing from where it always did.

/** One OpenAI-style chat message. The copilot prompt is always exactly two:
 *  a system message then a user message. */
export interface ChatMessage {
  role: "system" | "user" | "assistant"
  content: string
}

/**
 * A validated source→target pair surfaced from the project's cell store.
 * Used as few-shot examples that capture this team's terminology decisions.
 */
export interface ValidatedPair {
  cellId?: string
  source: string
  target: string
}

/**
 * The subset of `TranslationRule` (src/lib/parsers/types.ts) that prompt
 * injection actually reads. Declared structurally so this module stays
 * alias-free; `TranslationRule[]` is assignable to `PromptRule[]`.
 *
 * `builtin` checks are algorithmic and contribute no prompt text — they are
 * listed so the union stays exhaustive rather than falling through silently.
 */
export interface PromptRule {
  enabled: boolean
  check:
    | { type: "source-requires-target"; sourcePattern: string; targetPattern: string }
    | { type: "target-forbids"; targetPattern: string }
    | { type: "source-target-match"; pattern: string }
    | { type: "builtin" }
}

/**
 * Research-backed default for Luna: keep the global approved-example pool
 * small enough to stay focused, while leaving room for local discourse
 * context. This is a TOTAL prompt budget, not a per-retriever allowance.
 */
export const DEFAULT_APPROVED_EXAMPLE_COUNT = 10

function normalizedExampleSource(source: string): string {
  return source.trim().replace(/\s+/g, " ").toLowerCase()
}

/**
 * Merge canonical retrieval with the local approved-cell fallback into one
 * bounded prompt pool. Retrieved examples win; local cells only fill unused
 * slots. Examples already present in the live request or immediate discourse
 * window are excluded, and source text is preserved in full.
 */
export function selectApprovedExamples(
  retrieved: ValidatedPair[],
  fallback: ValidatedPair[],
  limit: number,
  excludedContext: { source: string }[] = [],
): ValidatedPair[] {
  if (limit <= 0) return []

  const excludedSources = new Set(
    excludedContext.map((context) => normalizedExampleSource(context.source)).filter(Boolean),
  )
  const seenSources = new Set<string>()
  const seenCellIds = new Set<string>()
  const selected: ValidatedPair[] = []

  for (const example of [...retrieved, ...fallback]) {
    if (selected.length >= limit) break
    const sourceKey = normalizedExampleSource(example.source)
    if (!sourceKey || !example.target.trim() || excludedSources.has(sourceKey)) continue
    if (seenSources.has(sourceKey) || (example.cellId && seenCellIds.has(example.cellId))) continue

    selected.push(example)
    seenSources.add(sourceKey)
    if (example.cellId) seenCellIds.add(example.cellId)
  }

  return selected
}

/**
 * Render active project rules as a concise terminology/guidance block that
 * can be injected into a system prompt. Only `source-requires-target` rules
 * are rendered as explicit "if you see X → use Y" guidance; other check
 * types become a simple "avoid: X" instruction. Disabled rules are skipped.
 *
 * Returns an empty string when there are no active, injectable rules.
 */
export function buildRulesBlock(rules: PromptRule[]): string {
  const active = rules.filter((r) => r.enabled)
  if (!active.length) return ""

  const lines: string[] = []
  for (const rule of active) {
    const { check } = rule
    if (check.type === "source-requires-target") {
      lines.push(`- When the source contains "${check.sourcePattern}", the translation must include "${check.targetPattern}".`)
    } else if (check.type === "target-forbids") {
      lines.push(`- Do NOT use "${check.targetPattern}" in the translation.`)
    } else if (check.type === "source-target-match") {
      lines.push(`- The pattern "${check.pattern}" must appear in the translation when present in the source.`)
    }
    // builtin checks are algorithmic; no useful prompt injection
  }

  if (!lines.length) return ""
  return "Project terminology and style rules (MUST follow):\n" + lines.join("\n")
}

/**
 * Render the style-rule instructions in force for the cell(s) being drafted
 * (AQU-934). Unlike `buildRulesBlock`, which can only speak the three regex
 * check shapes, these are natural-language rules resolved per passage from the
 * applicability graph — so the block carries exactly the guidance that applies
 * here, instead of every project rule on every call.
 *
 * Blank/duplicate instructions are dropped; empty input → "" (caller skips).
 */
export function buildStyleRulesBlock(instructions: string[] | undefined | null): string {
  const seen = new Set<string>()
  const lines: string[] = []
  for (const raw of instructions ?? []) {
    const instruction = raw.trim()
    if (!instruction || seen.has(instruction)) continue
    seen.add(instruction)
    lines.push(`- ${instruction}`)
  }
  if (!lines.length) return ""
  return "Style rules that apply to this passage (MUST follow):\n" + lines.join("\n")
}

/**
 * Render the brief's L1 summary as a labeled block for the system prompt.
 * Empty/blank input → "" (caller skips injection). The brief states the
 * project's purpose, audience, register, and constraints; it sits ABOVE the
 * mechanical rules block so the model reads intent before specifics.
 */
export function buildBriefBlock(summary: string | undefined | null): string {
  const s = (summary ?? "").trim()
  if (!s) return ""
  return "Translation brief (the project's purpose and standards — follow it):\n" + s
}

export const DEFAULT_SYSTEM_PROMPT =
  "You are a translation assistant completing a project that translates from {sourceLanguage} into {targetLanguage}.\n\n" +
  "The translation examples the user provides are your PRIMARY source of truth. Treat every observable convention in them as binding: reproduce the project's wording, spelling, tone, register, punctuation, formatting, and style rather than substituting defaults associated with the {targetLanguage} label. This may be an ultra-low-resource language, so follow the project's own evidence above general knowledge.\n\n" +
  "Always translate from {sourceLanguage} to {targetLanguage}, relying strictly on the reference data and context provided. The language may be an ultra-low-resource language, so it is critical to follow the patterns and style of the provided reference data closely.\n\n" +
  "To produce the translation, follow these steps:\n" +
  "1. Analyze the provided reference data to understand the translation patterns and style.\n" +
  "2. Complete the translation of the given source line or passage.\n" +
  "3. Ensure your translation is consistent with the existing partial translation and surrounding context.\n" +
  "4. Pay careful attention to the provided reference data — match its terminology, register, and conventions as closely as possible.\n" +
  "5. Translate only into {targetLanguage}.\n" +
  "6. When unsure, err on the side of literalness and stay consistent with the examples.\n" +
  "7. Preserve the line breaks and any inline formatting present in the source.\n\n" +
  "Output rules (strictly enforced):\n" +
  "- Output ONLY the {targetLanguage} translation of the final source line — nothing else.\n" +
  "- No commentary, explanations, labels, headers, markdown, language names, or restated source text. Just the translated text."

export interface BuildPromptOptions {
  sourceLanguage: string
  targetLanguage: string
  systemPrompt: string
  sourceText: string
  examples: { source: string; target: string }[]
  /** Active project rules — injected as a "must follow" block in the system prompt. */
  rules?: PromptRule[]
  /** Style-rule instructions resolved for this cell from the applicability
   *  graph (AQU-934) — injected after the rules block. */
  styleInstructions?: string[]
  /** Pre-filtered validated pairs from the project — prepended to examples. */
  validatedPairs?: ValidatedPair[]
  /** How to render few-shot examples. Default "source-and-target". */
  exampleFormat?: "source-and-target" | "target-only"
  /** The project brief's L1 summary — injected before the rules block. */
  briefSummary?: string
  /** Committed target of the immediately preceding cells (document order) — the
   *  discourse window. Rendered last (closest to the live source) because it is
   *  real continuity, not a retrieved example. Left-context is the TARGET, not the
   *  source: it is what gives connectives and participant reference real flow. (D4) */
  precedingContext?: { source: string; target: string }[]
  /** Extra task instruction appended to the system prompt after the rules
   *  block. Must be placeholder-free — it is appended AFTER the
   *  {sourceLanguage}/{targetLanguage} substitution. Used by the footnote
   *  output contract (buildFootnoteInstruction); instructions must live here,
   *  never inside `sourceText`, where they contradict the base prompt's
   *  "translate the final source line only" rule. */
  systemAddendum?: string
  /** Labelled context block rendered in the user message after
   *  precedingContext and immediately BEFORE the final `Source:` line — never
   *  inside it. Used for the source-footnote listing. */
  preSourceBlock?: string
}

export function buildPrompt(options: BuildPromptOptions): ChatMessage[] {
  let sys = options.systemPrompt
    .replace(/\{sourceLanguage\}/g, options.sourceLanguage)
    .replace(/\{targetLanguage\}/g, options.targetLanguage)

  const briefBlock = buildBriefBlock(options.briefSummary)
  if (briefBlock) sys = sys + "\n\n" + briefBlock

  // Inject rules block after the base system prompt so it is always visible.
  if (options.rules?.length) {
    const block = buildRulesBlock(options.rules)
    if (block) sys = sys + "\n\n" + block
  }

  const styleBlock = buildStyleRulesBlock(options.styleInstructions)
  if (styleBlock) sys = sys + "\n\n" + styleBlock

  if (options.systemAddendum) sys = sys + "\n\n" + options.systemAddendum

  const targetOnly = options.exampleFormat === "target-only"

  // Validated pairs lead the few-shot examples; search-retrieved examples follow.
  // Drop incomplete pairs (empty source or target): the branching-search corpus
  // keeps source-only cells (COALESCE(t.value,'') in loadCorpus) so in-progress
  // projects still retrieve neighbors, but an example with an empty target
  // teaches the model nothing and leaks a blank "Translation:" into the prompt.
  // Mirrors the reference impl (codex-editor shared.ts fetchFewShotExamples).
  // In target-only mode we still require a non-empty target; source is omitted.
  const allExamples = [...(options.validatedPairs ?? []), ...options.examples]
    .filter((ex) => (targetOnly ? ex.target.trim() : ex.source.trim() && ex.target.trim()))

  // In target-only mode, append a note so the model understands what the
  // examples represent (reference translations, not source→target alignments).
  if (targetOnly) {
    sys = sys + "\n\nThe examples provided are reference translations in the target language. Use them to imitate the style, terminology, and patterns of this project."
  }

  let user = ""
  if (targetOnly) {
    for (const ex of allExamples) user += `Target: ${ex.target}\n\n`
  } else {
    for (const ex of allExamples) user += `Source: ${ex.source}\nTranslation: ${ex.target}\n\n`
  }
  // Immediately-preceding committed context (discourse window): render after the
  // few-shot examples and just before the live source so it sits closest to what
  // the model is about to translate. Skip blank pairs. (D4)
  for (const ctx of options.precedingContext ?? []) {
    if (ctx.source.trim() && ctx.target.trim()) {
      user += `Source: ${ctx.source}\nTranslation: ${ctx.target}\n\n`
    }
  }
  if (options.preSourceBlock) user += `${options.preSourceBlock}\n\n`
  user += `Source: ${options.sourceText}\nTranslation:`

  return [{ role: "system", content: sys }, { role: "user", content: user.trim() }]
}
