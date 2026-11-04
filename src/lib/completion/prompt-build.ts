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

import { stripTrailingBareMarkers } from "./strip-trailing-usfm-markers"
import {
  DEFAULT_SYSTEM_PROMPT,
  instructionsPromptBlock,
} from "../../../db/shared/translation-instructions"
import {
  assemblePromptSections,
  checksHintBlock,
  terminologyBlock,
  type TermHint,
} from "../../../db/shared/prompt-blocks"
import type { LanguageProfile } from "../../../db/shared/language-profile"

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
 * Regex-free, locale-independent term data that `compileConceptsToRulesCore`
 * attaches to the rules it compiles from a project's termbase (`term:…` ids).
 *
 * AQU-2209: prompt injection reads THIS, never the match patterns. Rendering
 * the patterns was injecting the whole glossary as raw regex into every draft
 * call — a 722-concept termbase meant 722 lines like
 * `"(?<![\p{L}\p{M}])Moses(?![\p{L}\p{M}])"`, a 115 KB system prompt for a
 * 213-char source. The boundary wrappers are the matcher's internals and
 * carry no meaning for a model, and the two terms that actually occurred in
 * the cell were buried in the 720 that did not — so adherence got WORSE as
 * the glossary got better, which is the opposite of the point of a termbase.
 *
 * `sourcePattern` stays here so injection can ask the only question that
 * matters — is this concept present in THIS cell's source? — using the exact
 * pattern `rule-engine` lints with, so the prompt promises what the engine
 * enforces.
 */
export interface PromptTermInfo {
  /** The concept this rule compiled from. Rules sharing one render as one line. */
  conceptId: string
  /** The glossary's own spelling of the source term — what the model reads. */
  sourceTerm: string
  /** Regex source matching the concept in SOURCE text. Wildcards, project
   *  affixes and mark folding are already baked in by the shared matcher. */
  sourcePattern: string
  caseSensitive?: boolean
  /** Preferred + admitted renderings, plain text (the `:approved` rule). */
  approved?: string[]
  /** The single forbidden rendering this rule names (a `:forbidden:…` rule). */
  forbidden?: string
  /** The termbase entry's note (AQU-2342: shown, clipped, on every path). */
  notes?: string
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
  id?: string
  name?: string
  /** What the rule requires, as the team wrote it. The checks hint prefers it
   *  over the pattern shape (db/shared/prompt-blocks.ts). */
  description?: string
  enabled: boolean
  check:
    | { type: "source-requires-target"; sourcePattern: string; targetPattern: string }
    | { type: "target-forbids"; targetPattern: string }
    | { type: "source-target-match"; pattern: string }
    | { type: "builtin" }
  /** Terminology rules only (AQU-2209). A rule carrying this is injected ONLY
   *  when `term.sourcePattern` occurs in the source being drafted, and is
   *  rendered from its plain fields instead of its `check` patterns. */
  term?: PromptTermInfo
}

/**
 * Research-backed default for Luna: keep the global approved-example pool
 * small enough to stay focused, while leaving room for local discourse
 * context. This is a TOTAL prompt budget, not a per-retriever allowance.
 */
export const DEFAULT_APPROVED_EXAMPLE_COUNT = 10

/**
 * One row of the immediate discourse window.
 *
 * `draft` marks a target this same run produced and NOBODY has reviewed
 * (AQU-1386 §3). Batch drafting sends several calls in sequence; without this,
 * call N+1 could not see call N's output at all and every chunk started its
 * discourse cold. Carrying it forward is what keeps connectives and participant
 * reference consistent across a long file.
 *
 * It is labelled in the prompt rather than silently mixed in, because the model
 * should weigh an unreviewed draft less than an approved translation. The rule
 * that unapproved text never becomes a retrieval EXAMPLE is untouched: this is
 * in-run context only, is never persisted, and never crosses runs.
 */
export interface PrecedingContextEntry {
  source: string
  target: string
  /** In-run, unreviewed draft — labelled as such in the rendered prompt. */
  draft?: boolean
}

/** Prompt label for one discourse-window row. */
export function precedingContextLabel(entry: PrecedingContextEntry): string {
  return entry.draft ? "Translation (unreviewed draft)" : "Translation"
}

function normalizedExampleSource(source: string): string {
  return source.trim().replace(/\s+/g, " ").toLowerCase()
}

/**
 * AQU-153: a retrieval hit only becomes a translation example once it carries
 * a real source→target pair. Branching search ranks SOURCE cells, so an
 * untranslated cell is a legitimate hit — it is just not an example, because
 * there is nothing for the model to imitate. Callers that count or display
 * "examples" run their hits through here so the number they report is the
 * number of actual pairs, never the raw source-side hit count. (Without it, a
 * brand-new project with nothing translated still claimed "5 examples used.")
 *
 * `selectApprovedExamples` applies the same rule to the prompt pool; this is
 * the same invariant for the evidence surfaces, so the two cannot drift.
 */
export function retainTranslationPairs<T extends { source: string; target: string }>(
  hits: readonly T[],
): T[] {
  return hits.filter((hit) => hit.source.trim() !== "" && hit.target.trim() !== "")
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
 * How many distinct glossary concepts one call may inject (AQU-2209). The
 * terms that actually occur in a cell are few, so this is a backstop for a
 * pathological source (a term list, a long merged paragraph) against a large
 * termbase: prompt size is then bounded by the cap, not by the glossary.
 * Overflow is reported by `selectInjectedTerms`, never silently swallowed.
 */
export const DEFAULT_MAX_INJECTED_TERMS = 40

/** One concept's injectable guidance, merged across its compiled rules. */
export interface InjectedTerm {
  conceptId: string
  sourceTerm: string
  approvedRenderings: string[]
  forbiddenRenderings: string[]
  notes?: string
}

export interface TermSelection {
  /** Concepts present in the source, in compile order, after the cap. */
  injected: InjectedTerm[]
  /** How many concepts were present in the source BEFORE the cap. */
  matched: number
  /** How many present concepts the cap left out (`matched - injected.length`). */
  dropped: number
}

/**
 * Does a compiled term pattern occur in the source?
 *
 * The shared matcher emits Unicode property escapes (`\p{L}`), which REQUIRE
 * the `u` flag — the same opt-in `rule-engine` makes for `term:` rules alone.
 * A pattern that will not compile counts as absent, matching the engine
 * (which declines to fire a rule it cannot compile), so injection never
 * promises a constraint the engine would not enforce.
 */
function termPatternOccurs(pattern: string, caseSensitive: boolean, sourceText: string): boolean {
  if (!sourceText) return false
  try {
    return new RegExp(pattern, caseSensitive ? "u" : "iu").test(sourceText)
  } catch {
    return false
  }
}

/**
 * Narrow a project's compiled terminology to the concepts that actually occur
 * in `sourceText` (AQU-2209), merging each concept's rules — one `:approved`
 * plus one `:forbidden:…` per forbidden rendering — back into a single entry.
 *
 * Concepts keep their compile order, which is deliberate: subscribed org
 * termbases first (highest precedence), then the project's own. So when the
 * cap bites, it drops the lowest-precedence matches.
 *
 * Exported because the Agent API's prompt preview reports the selection as
 * `parts.injectedTerms` and warns on `dropped` — an agent tuning a termbase
 * needs to see which terms landed, and the preview must not re-derive that.
 */
export function selectInjectedTerms(
  rules: readonly PromptRule[],
  sourceText: string,
  maxTerms: number = DEFAULT_MAX_INJECTED_TERMS,
): TermSelection {
  const byConcept = new Map<string, InjectedTerm>()
  // One regex test per distinct pattern: a concept's rules all share one.
  const presence = new Map<string, boolean>()

  for (const rule of rules) {
    if (!rule.enabled || !rule.term) continue
    const { term } = rule
    const caseSensitive = term.caseSensitive === true
    const key = `${caseSensitive ? "s" : "i"}\u0000${term.sourcePattern}`
    let present = presence.get(key)
    if (present === undefined) {
      present = termPatternOccurs(term.sourcePattern, caseSensitive, sourceText)
      presence.set(key, present)
    }
    if (!present) continue

    let entry = byConcept.get(term.conceptId)
    if (!entry) {
      entry = {
        conceptId: term.conceptId,
        sourceTerm: term.sourceTerm,
        approvedRenderings: [],
        forbiddenRenderings: [],
        ...(term.notes ? { notes: term.notes } : {}),
      }
      byConcept.set(term.conceptId, entry)
    }
    for (const rendering of term.approved ?? []) {
      if (rendering && !entry.approvedRenderings.includes(rendering)) {
        entry.approvedRenderings.push(rendering)
      }
    }
    if (term.forbidden && !entry.forbiddenRenderings.includes(term.forbidden)) {
      entry.forbiddenRenderings.push(term.forbidden)
    }
  }

  const matched = [...byConcept.values()]
  const limit = maxTerms > 0 ? maxTerms : 0
  return {
    injected: matched.slice(0, limit),
    matched: matched.length,
    dropped: Math.max(0, matched.length - limit),
  }
}

/** An injected concept as the shared terminology block reads it. */
export function injectedTermHint(term: InjectedTerm): TermHint {
  return {
    sourceTerm: term.sourceTerm,
    approved: term.approvedRenderings,
    forbidden: term.forbiddenRenderings,
    ...(term.notes ? { notes: term.notes } : {}),
  }
}

/**
 * The Terminology block for the text about to be drafted (AQU-2209 narrowing,
 * AQU-2342 shared rendering): the terminology rules — the ones carrying
 * `term`, compiled from the project's termbase — narrowed to the concepts that
 * occur in `sourceText`, rendered as plain `"Moses" → "Moisés"` lines with the
 * entry's note. With no `sourceText` nothing is injected: injecting the whole
 * table is the bug AQU-2209 replaced. "" when no term occurs.
 */
export function buildTerminologyBlock(
  rules: readonly PromptRule[] | undefined,
  options: { sourceText?: string; maxTerms?: number } = {},
): string {
  if (!rules?.length) return ""
  const { injected } = selectInjectedTerms(rules, options.sourceText ?? "", options.maxTerms)
  return terminologyBlock(injected.map(injectedTermHint))
}

/**
 * The Checks hint (AQU-2342): the project/lane/org rules, the style rules in
 * force for this passage (AQU-934, resolved per passage from the
 * applicability graph) and the Language-profile slots the Bible data checks
 * verify — rendered by the ONE shared builder every drafting path uses.
 * Terminology rules are skipped (they are the Terminology block); built-in
 * checks contribute nothing (algorithmic). "" when nothing can be hinted.
 */
export function buildChecksBlock(
  rules: readonly PromptRule[] | undefined,
  styleInstructions?: readonly string[] | null,
  languageProfile?: LanguageProfile | null,
): string {
  return checksHintBlock({
    rules: rules ?? [],
    styleInstructions: styleInstructions ?? [],
    languageProfile: languageProfile ?? null,
  })
}

/** The copilot's standing guidance, in the one order (db/shared/prompt-blocks):
 *  Instructions → Checks → Terminology. Shared by the single-cell, batch and
 *  paragraph builders and therefore by the Agent API's prompt preview. */
export function copilotGuidanceBlocks(options: {
  instructions?: string
  rules?: readonly PromptRule[]
  styleInstructions?: readonly string[]
  languageProfile?: LanguageProfile | null
  sourceText: string
}): string {
  return assemblePromptSections({
    instructions: instructionsPromptBlock(options.instructions),
    checks: buildChecksBlock(options.rules, options.styleInstructions, options.languageProfile),
    terminology: buildTerminologyBlock(options.rules, { sourceText: options.sourceText }),
  })
}

// AQU-2342: the fixed role text and the one project-instructions block live in
// db/shared so every drafting path (and the migrate-on-read resolver) shares
// them. The copilot's role text is no longer user-editable.
export { DEFAULT_SYSTEM_PROMPT, instructionsPromptBlock }

export interface BuildPromptOptions {
  sourceLanguage: string
  targetLanguage: string
  /** The fixed role text. Defaults to DEFAULT_SYSTEM_PROMPT; the copilot never
   *  passes a project-authored prompt here (AQU-2342). */
  systemPrompt?: string
  sourceText: string
  examples: { source: string; target: string }[]
  /** Active project rules (org, project, lane, terminology) — the checks hint
   *  and, narrowed to this source, the terminology block. */
  rules?: PromptRule[]
  /** Style-rule instructions resolved for this cell from the applicability
   *  graph (AQU-934) — part of the checks hint. */
  styleInstructions?: string[]
  /** The Language profile — its filled slots join the checks hint. */
  languageProfile?: LanguageProfile | null
  /** Pre-filtered validated pairs from the project — prepended to examples. */
  validatedPairs?: ValidatedPair[]
  /** How to render few-shot examples. Default "source-and-target". */
  exampleFormat?: "source-and-target" | "target-only"
  /** The project instructions (resolveTranslationInstructions) — injected
   *  right after the role text, before the rules block. */
  instructions?: string
  /** Committed target of the immediately preceding cells (document order) — the
   *  discourse window. Rendered last (closest to the live source) because it is
   *  real continuity, not a retrieved example. Left-context is the TARGET, not the
   *  source: it is what gives connectives and participant reference real flow. (D4) */
  precedingContext?: PrecedingContextEntry[]
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
  // One order for every drafting path (db/shared/prompt-blocks.ts): role →
  // Instructions → Checks → Terminology here in the system message, then the
  // examples and discourse context in the user message. Guidance rides with
  // the role text through the placeholder pass: text migrated from a
  // customized system prompt may still say "{targetLanguage}".
  const guidance = copilotGuidanceBlocks({ ...options, sourceText: options.sourceText })
  let sys = ((options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT) + (guidance ? "\n\n" + guidance : ""))
    .replace(/\{sourceLanguage\}/g, options.sourceLanguage)
    .replace(/\{targetLanguage\}/g, options.targetLanguage)

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
    for (const ex of allExamples) user += `Target: ${stripTrailingBareMarkers(ex.target)}\n\n`
  } else {
    for (const ex of allExamples) {
      user += `Source: ${stripTrailingBareMarkers(ex.source)}\nTranslation: ${stripTrailingBareMarkers(ex.target)}\n\n`
    }
  }
  // Immediately-preceding committed context (discourse window): render after the
  // few-shot examples and just before the live source so it sits closest to what
  // the model is about to translate. Skip blank pairs. (D4)
  for (const ctx of options.precedingContext ?? []) {
    if (ctx.source.trim() && ctx.target.trim()) {
      user += `Source: ${stripTrailingBareMarkers(ctx.source)}\n${precedingContextLabel(ctx)}: ${stripTrailingBareMarkers(ctx.target)}\n\n`
    }
  }
  if (options.preSourceBlock) user += `${options.preSourceBlock}\n\n`
  user += `Source: ${stripTrailingBareMarkers(options.sourceText)}\nTranslation:`

  return [{ role: "system", content: sys }, { role: "user", content: user.trim() }]
}
