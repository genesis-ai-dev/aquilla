import type { CompletionSettings, CompletionProvider, TranslationRule } from "@/lib/parsers/types"
import type { FrontierSession } from "@/lib/frontier/types"
import { resolveApiKey } from "@/lib/store/user-api-keys"
import { effectiveSourceText, type SourceTextCell } from "@/lib/cell-text"
import { getUserProviderOverride } from "@/lib/store/user-provider-override"

// ---------------------------------------------------------------------------
// Memory primitives
// ---------------------------------------------------------------------------

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
 * Extract validated source→target pairs from a snapshot of the project's
 * cells. Only cells with `status === "validated"` and non-empty content on
 * both sides are included.
 *
 * Optionally ranked by relevance to a query string: if `query` is provided,
 * pairs whose source text shares any token with the query are promoted to the
 * front. Token overlap is a cheap proxy for subject-matter similarity — good
 * enough to bias the model toward domain-relevant examples without a
 * vector store.
 *
 * @param cells - snapshot from useCells (must have `status`, `original`, `translated`)
 * @param query - optional source text of the cell being drafted (for relevance ranking)
 * @param limit - max pairs to return (default 20; callers may want fewer)
 */
export function collectValidatedPairs(
  cells: ({ id?: string; status: string; translated: string } & SourceTextCell)[],
  query?: string,
  limit = 20,
): ValidatedPair[] {
  // SUB-28: example sources read through effectiveSourceText — a validated
  // media section contributes its TRANSCRIPT, never the import filename, and
  // an untranscribed one is dropped by the trim filter.
  const validated = cells
    .map((c) => ({ cell: c, source: effectiveSourceText(c) }))
    .filter((x) => x.cell.status === "validated" && x.source.trim() && x.cell.translated.trim())

  if (query && query.trim()) {
    // Token overlap: lower-case split on whitespace/punctuation
    const queryTokens = new Set(
      query.toLowerCase().split(/[\s\p{P}]+/u).filter(Boolean),
    )
    const withScore = validated.map((x) => {
      const srcTokens = x.source.toLowerCase().split(/[\s\p{P}]+/u).filter(Boolean)
      const overlap = srcTokens.filter((t) => queryTokens.has(t)).length
      return { pair: x, overlap }
    })
    withScore.sort((a, b) => b.overlap - a.overlap)
    return withScore.slice(0, limit).map((x) => ({
      ...(x.pair.cell.id ? { cellId: x.pair.cell.id } : {}),
      source: x.pair.source,
      target: x.pair.cell.translated,
    }))
  }

  return validated.slice(0, limit).map((x) => ({
    ...(x.cell.id ? { cellId: x.cell.id } : {}),
    source: x.source,
    target: x.cell.translated,
  }))
}

/**
 * Render active project rules as a concise terminology/guidance block that
 * can be injected into a system prompt. Only `source-requires-target` rules
 * are rendered as explicit "if you see X → use Y" guidance; other check
 * types become a simple "avoid: X" instruction. Disabled rules are skipped.
 *
 * Returns an empty string when there are no active, injectable rules.
 */
export function buildRulesBlock(rules: TranslationRule[]): string {
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

export const DEFAULT_COMPLETION_MAX_TOKENS = 16384

// Former defaults (512 pre-2026-07-29, then 4096). Saving any project setting
// snapshots the whole CompletionSettings object, so projects carry these as
// persisted values that override a raised default — indistinguishable from a
// deliberate choice. Drafting treats them as "never customized" (see
// normalizeCompletionMaxTokens); a hand-set value other than these is kept.
const LEGACY_COMPLETION_MAX_TOKENS = new Set([512, 4096])

/** Effective drafting output budget: legacy default snapshots (and unset) map
 * to the current default; any other stored value is respected as-is. */
export function normalizeCompletionMaxTokens(value: number | undefined): number {
  return !value || LEGACY_COMPLETION_MAX_TOKENS.has(value)
    ? DEFAULT_COMPLETION_MAX_TOKENS
    : value
}

// VITE_CHAT_BASE points at the chat-completion proxy. Since 2026-05-26 this
// is the aquilla-identity worker (mounted at api.aquilla.app/chat — the
// former aquilla-chat-worker was folded in to consolidate the JWT secret).
// CI wires it per-branch (prod → https://api.aquilla.app/chat, anything else
// → https://api.dev.aquilla.app/chat). Pre-migration the URL was
// aquilla.app/api/chat under the apex.
// VITE_FRONTIER_BASE is retained as a fallback so the E2E suite — which
// spins up a mock LLM server and sets that env var — keeps working.
const CHAT_BASE_FALLBACK =
  ((import.meta.env.VITE_FRONTIER_BASE as string | undefined)?.replace(/\/+$/, "")) || ""
const CHAT_BASE_OVERRIDE =
  ((import.meta.env.VITE_CHAT_BASE as string | undefined)?.replace(/\/+$/, "")) || ""
export const FRONTIER_CHAT_URL = `${CHAT_BASE_OVERRIDE || CHAT_BASE_FALLBACK || "https://api.aquilla.app/chat"}/api/v1/chat/completions`

interface ChatMessage { role: "system" | "user" | "assistant"; content: string }

/**
 * The project id of the project currently being edited, derived from the SPA
 * route (`/project/:id/...` or `/projects/:id`), or null when not on a
 * project surface.
 *
 * AQU-414 follow-up: chat spend is billed to the org of the project in scope
 * when the completion is invoked. Every completion caller (copilot drafts,
 * backtranslation, brief generator, rule extract/suggest/autofix) runs on a
 * project route, so the URL IS the project context — deriving it here means
 * one attribution point instead of threading projectId through six services
 * and their call sites. Static segments like /projects/archived are excluded.
 */
export function activeProjectIdFromPath(pathname: string): string | null {
  const m = /^\/projects?\/([^/]+)/.exec(pathname)
  if (!m) return null
  const id = m[1]
  return id === "archived" ? null : id
}

/**
 * Pre-migration CompletionSettings records don't have `provider` set.
 * Infer: empty endpoint → "frontier" (new default); populated → "custom"
 * (preserves existing self-hosted/local setups). Saved-through on next write.
 */
export function resolveProvider(settings: CompletionSettings): CompletionProvider {
  if (settings.provider) return settings.provider
  // Tolerate partial records: server-synced overlays can produce a
  // completionSettings object containing only `systemPrompt` (see
  // useProject.ts overlaySettings), and legacy IDB rows predate `endpoint`.
  return (settings.endpoint ?? "").trim() ? "custom" : "frontier"
}

export function buildPrompt(options: {
  sourceLanguage: string; targetLanguage: string; systemPrompt: string
  sourceText: string; examples: { source: string; target: string }[]
  /** Active project rules — injected as a "must follow" block in the system prompt. */
  rules?: TranslationRule[]
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
}): ChatMessage[] {
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

// A segmented prompt preserves passage context (pronoun antecedents, tense
// agreement, discourse cohesion). Current evidence does not establish that a
// larger joint call inherently improves draft quality. Numbered <vN> tags let
// the response be demuxed back to individual cells; numbered tags (not bare <v>) ensure a
// missing/extra tag in the response is per-cell recoverable.
const BATCH_FRAMING_INSTRUCTIONS =
  "The source is segmented with <v1>, <v2>, ... tags. " +
  "Produce a translation segmented with the same tags, in the same order, with the same count. " +
  "Do not merge, split, omit, or reorder segments."

export interface PassageExample {
  // Aligned source/target rows; rendered as mirrored <vN> in the prompt so the
  // model sees the segmented format demonstrated, not just described.
  cells: { source: string; target: string }[]
}

export function buildBatchPrompt(options: {
  sourceLanguage: string; targetLanguage: string; systemPrompt: string
  cells: { source: string }[]
  examples: PassageExample[]
  /** Active project rules — injected as a "must follow" block in the system prompt. */
  rules?: TranslationRule[]
  /** Pre-filtered validated pairs from the project — prepended as a passage example. */
  validatedPairs?: ValidatedPair[]
  /** How to render few-shot examples. Default "source-and-target". */
  exampleFormat?: "source-and-target" | "target-only"
  /** The project brief's L1 summary — injected before the rules block. */
  briefSummary?: string
  /** Format-specific output contract appended after project rules. */
  systemAddendum?: string
  /** Approved bilingual pairs immediately preceding the first live cell. */
  precedingContext?: { source: string; target: string }[]
}): ChatMessage[] {
  const targetOnly = options.exampleFormat === "target-only"

  let baseSys = BATCH_FRAMING_INSTRUCTIONS + "\n\n" + options.systemPrompt
  const batchBriefBlock = buildBriefBlock(options.briefSummary)
  if (batchBriefBlock) baseSys = baseSys + "\n\n" + batchBriefBlock
  // Inject rules block after the base system prompt.
  if (options.rules?.length) {
    const block = buildRulesBlock(options.rules)
    if (block) baseSys = baseSys + "\n\n" + block
  }
  if (options.systemAddendum) baseSys = baseSys + "\n\n" + options.systemAddendum
  if (targetOnly) {
    baseSys = baseSys + "\n\nThe examples provided are reference translations in the target language. Use them to imitate the style, terminology, and patterns of this project."
  }

  const sys = baseSys
    .replace(/\{sourceLanguage\}/g, options.sourceLanguage)
    .replace(/\{targetLanguage\}/g, options.targetLanguage)

  const renderSide = (rows: { source: string; target: string }[], side: "source" | "target") =>
    rows.map((r, i) => `<v${i + 1}>${side === "source" ? r.source : r.target}</v${i + 1}>`).join("\n")

  let user = ""
  // Validated pairs from the project's living memory come first — they are
  // the strongest signal of this team's terminology decisions.
  if (options.validatedPairs?.length) {
    if (targetOnly) {
      const pairs = options.validatedPairs.filter((p) => p.target.trim())
      if (pairs.length) {
        user += `Translation:\n${renderSide(pairs, "target")}\n\n`
      }
    } else {
      user += `Source:\n${renderSide(options.validatedPairs, "source")}\n\nTranslation:\n${renderSide(options.validatedPairs, "target")}\n\n`
    }
  }
  for (const ex of options.examples) {
    // Passage neighbors include source-only cells (untranslated context within
    // the retrieved span). Filter pairwise so source/target <vN> lists stay
    // aligned and no blank target leaks into the demonstrated passage.
    const cells = ex.cells.filter((c) => c.source.trim() && c.target.trim())
    if (!cells.length) continue
    if (targetOnly) {
      user += `Translation:\n${renderSide(cells, "target")}\n\n`
    } else {
      user += `Source:\n${renderSide(cells, "source")}\n\nTranslation:\n${renderSide(cells, "target")}\n\n`
    }
  }
  // Keep immediate discourse context closest to the live batch, matching the
  // single-cell and paragraph recipes.
  for (const ctx of options.precedingContext ?? []) {
    if (ctx.source.trim() && ctx.target.trim()) {
      user += `Source: ${ctx.source}\nTranslation: ${ctx.target}\n\n`
    }
  }
  const liveSource = options.cells.map((c, i) => `<v${i + 1}>${c.source}</v${i + 1}>`).join("\n")
  user += `Source:\n${liveSource}\n\nTranslation:\n`

  return [{ role: "system", content: sys }, { role: "user", content: user.trim() }]
}

// ---------------------------------------------------------------------------
// Paragraph-unit prompt builder (D3, D4, D11) — additive, does NOT alter
// buildPrompt/buildBatchPrompt.
// ---------------------------------------------------------------------------

// We compress the INVARIANT (examples/terminology) precisely so the freed token budget
// can hold the VARIANT (discourse window). v1 spent the whole budget re-dumping examples
// and had no room for discourse — which is why it produced translationese. (background)

const PARAGRAPH_SYSTEM_SUFFIX =
  "\n\nYou are translating a PARAGRAPH — an ordered group of source cells. " +
  "Each cell is wrapped in a <c id=\"CELL_ID\"> tag that carries the stable cell identifier. " +
  "Respond with the SAME tags in the SAME order: <c id=\"CELL_ID\">TRANSLATION</c>. " +
  "Do not merge, split, omit, reorder, or invent cell ids. " +
  "Translate only into {targetLanguage}. No commentary."

export interface ParagraphPromptCell {
  cellId: string
  source: string
  /**
   * p1-paragraph-ui-wiring (coordinator adjudication): present when this
   * cell's target is already validated and therefore excluded from
   * translation (completeParagraph's skip-validated-cells guard). The cell
   * still renders IN POSITION within the source paragraph — as a locked
   * reference segment, never a `<c id>` tag — so drafted neighbors don't
   * read as artificially contiguous across a silently-dropped gap. Absent/
   * undefined ⇒ a normal draftable cell (today's `<c id>` behavior).
   */
  lockedTarget?: string
}

export function buildParagraphPrompt(options: {
  sourceLanguage: string
  targetLanguage: string
  systemPrompt: string
  /** The paragraph's source cells, in document order. */
  cells: ParagraphPromptCell[]
  /** Few-shot examples (whole passages). Same format as buildBatchPrompt. */
  examples: PassageExample[]
  /** Validated source→target pairs from living memory. */
  validatedPairs?: ValidatedPair[]
  /** Active project rules injected into the system prompt. */
  rules?: TranslationRule[]
  /** Project brief L1 summary. */
  briefSummary?: string
  /** Format-specific output contract appended after project rules. */
  systemAddendum?: string
  /** How to render few-shot examples. */
  exampleFormat?: "source-and-target" | "target-only"
  // Left-context is the COMMITTED TARGET of preceding paragraphs (not source): this is what
  // gives real discourse flow — connectives and participant reference that follow what was
  // actually said in the target language. Falls back to source before anything is committed. (D4)
  /** Preceding committed target context (discourse window left side). */
  precedingContext?: { source: string; target: string }[]
  /** Following source context (discourse window right side) — source only, no committed target. */
  followingSource?: { source: string }[]
}): ChatMessage[] {
  const targetOnly = options.exampleFormat === "target-only"

  // Build system prompt: base + framing + brief + rules
  const framingSuffix = PARAGRAPH_SYSTEM_SUFFIX
    .replace(/\{targetLanguage\}/g, options.targetLanguage)

  let sys = (options.systemPrompt + framingSuffix)
    .replace(/\{sourceLanguage\}/g, options.sourceLanguage)
    .replace(/\{targetLanguage\}/g, options.targetLanguage)

  const briefBlock = buildBriefBlock(options.briefSummary)
  if (briefBlock) sys = sys + "\n\n" + briefBlock

  if (options.rules?.length) {
    const block = buildRulesBlock(options.rules)
    if (block) sys = sys + "\n\n" + block
  }
  if (options.systemAddendum) sys = sys + "\n\n" + options.systemAddendum

  if (targetOnly) {
    sys = sys + "\n\nThe examples provided are reference translations in the target language. Use them to imitate the style, terminology, and patterns of this project."
  }

  // p1-paragraph-ui-wiring (coordinator adjudication): warn the model about
  // locked segments ONLY when at least one is present, so callers with no
  // validated cells in the group (today's only path, and every existing
  // test) see byte-identical system prompt output.
  const hasLockedCells = options.cells.some((c) => c.lockedTarget !== undefined)
  if (hasLockedCells) {
    sys = sys + "\n\nSome segments in the source paragraph are marked "
      + "\"[already translated — do not output: ...]\" — these are already "
      + "committed, validated translations. Do NOT translate them, do NOT "
      + "emit a <c id> tag for them, and do NOT repeat their text in your response."
  }

  // Build user message: examples → discourse window → live paragraph
  let user = ""

  // Validated pairs (living memory) lead as the strongest signal.
  if (options.validatedPairs?.length) {
    const pairs = options.validatedPairs.filter((p) =>
      targetOnly ? p.target.trim() : p.source.trim() && p.target.trim(),
    )
    if (pairs.length) {
      if (targetOnly) {
        user += pairs.map((p) => `Target: ${p.target}`).join("\n\n") + "\n\n"
      } else {
        user += pairs.map((p) => `Source: ${p.source}\nTranslation: ${p.target}`).join("\n\n") + "\n\n"
      }
    }
  }

  // Retrieved passage examples.
  const renderSide = (rows: { source: string; target: string }[], side: "source" | "target") =>
    rows.map((r, i) => `<v${i + 1}>${side === "source" ? r.source : r.target}</v${i + 1}>`).join("\n")

  for (const ex of options.examples) {
    const cells = ex.cells.filter((c) => c.source.trim() && c.target.trim())
    if (!cells.length) continue
    if (targetOnly) {
      user += `Translation:\n${renderSide(cells, "target")}\n\n`
    } else {
      user += `Source:\n${renderSide(cells, "source")}\n\nTranslation:\n${renderSide(cells, "target")}\n\n`
    }
  }

  // Discourse window — preceding committed target (left).
  // Left-context is the COMMITTED TARGET of preceding paragraphs (not source): this is what
  // gives real discourse flow — connectives and participant reference that follow what was
  // actually said in the target language. Falls back to source before anything is committed. (D4)
  if (options.precedingContext?.length) {
    for (const ctx of options.precedingContext) {
      if (ctx.source.trim() && ctx.target.trim()) {
        user += `Source: ${ctx.source}\nTranslation: ${ctx.target}\n\n`
      } else if (ctx.source.trim()) {
        // D4 source-fallback: no committed target yet — surface the preceding
        // source as discourse context WITHOUT a Source/Translation pair the model
        // could mimic by echoing a blank "translation".
        user += `Preceding (source, not yet translated): ${ctx.source}\n\n`
      }
    }
  }

  // Discourse window — following source (right). Source only; no target available yet.
  if (options.followingSource?.length) {
    const followingSrc = options.followingSource.filter((f) => f.source.trim())
    if (followingSrc.length) {
      // Encode as a context block so the model sees what comes next without
      // being asked to translate it (it will translate the live paragraph).
      user += `Following context (source only — do not translate this block):\n`
      user += followingSrc.map((f) => f.source).join("\n") + "\n\n"
    }
  }

  // Live paragraph: encode DRAFTABLE source cells with stable <c id> tags
  // (D11). A locked (already-validated) cell renders IN POSITION instead —
  // source text plus its existing committed target, clearly marked, and
  // deliberately NOT wrapped in a <c id> tag — so a validated cell sitting
  // mid-group doesn't leave a silent gap that makes its drafted neighbors
  // read as artificially adjacent. If the model emits a stray tag for a
  // locked cell anyway, parseParagraphResponse's expectedIds already
  // excludes it, so it's discarded as `extra` (D11) — unchanged.
  const liveSource = options.cells
    .map((c) => (c.lockedTarget !== undefined
      ? `${c.source} [already translated — do not output: ${c.lockedTarget}]`
      : `<c id="${c.cellId}">${c.source}</c>`))
    .join("\n")
  user += `Source paragraph:\n${liveSource}\n\nTranslation paragraph:\n`

  return [{ role: "system", content: sys }, { role: "user", content: user.trim() }]
}

/**
 * Normalize a user-supplied OpenAI-compatible base URL into endpoints for
 * `/chat/completions` and `/models`. Accepts:
 *   - "http://localhost:8000"                          (we append /v1/...)
 *   - "https://openrouter.ai/api/v1"                   (already has /v1)
 *   - "https://openrouter.ai/api/v1/chat/completions"  (full chat URL)
 * Trailing slashes are ignored.
 */
export function normalizeOpenAIBaseUrl(endpoint: string): { chatUrl: string; modelsUrl: string } {
  const trimmed = endpoint.trim().replace(/\/+$/, "")
  if (trimmed.endsWith("/chat/completions")) {
    const base = trimmed.slice(0, -"/chat/completions".length)
    return { chatUrl: trimmed, modelsUrl: `${base}/models` }
  }
  if (/\/v\d+$/.test(trimmed)) {
    return { chatUrl: `${trimmed}/chat/completions`, modelsUrl: `${trimmed}/models` }
  }
  return { chatUrl: `${trimmed}/v1/chat/completions`, modelsUrl: `${trimmed}/v1/models` }
}

export async function fetchModels(endpoint: string, apiKey?: string): Promise<string[]> {
  const { modelsUrl } = normalizeOpenAIBaseUrl(endpoint)
  const headers: Record<string, string> = {}
  if (apiKey?.trim()) headers.Authorization = `Bearer ${apiKey.trim()}`
  const res = await fetch(modelsUrl, { headers })
  if (!res.ok) throw new Error(`Failed to fetch models: ${res.status} ${res.statusText}`)
  const data = await res.json()
  return data.data.map((m: { id: string }) => m.id)
}

/**
 * Model A/B assignment echoed by the frontier worker (routes/chat.ts) when a
 * platform experiment served this request. The SPA uses `requestId` to report
 * what the user did with the output (see src/lib/ab/feedback.ts).
 */
export interface AbAssignment {
  requestId: string
  arm: "champion" | "challenger"
  model: string
}

export interface CompleteOptions {
  settings: CompletionSettings
  session: FrontierSession | null
  messages: ChatMessage[]
  stream?: boolean
  onChunk?: (text: string) => void
  /** If provided, the in-flight fetch and stream are aborted when signalled. */
  signal?: AbortSignal
  /** Request watchdog. Override only in focused tests. */
  timeoutMs?: number
  /** Called when the response carries an X-AB-* model-experiment assignment. */
  onAbAssignment?: (ab: AbAssignment) => void
}

export async function complete(options: CompleteOptions): Promise<string> {
  // Personal per-device override (set in user Settings) takes precedence over
  // the project's completionSettings. This is the "advanced" path: the user
  // wants their own endpoint/key for everything they translate on this device.
  const override = getUserProviderOverride()
  const effectiveSettings: CompletionSettings = override
    ? {
        ...options.settings,
        provider: "custom",
        endpoint: override.endpoint,
        model: override.model || options.settings.model,
        apiKey: override.apiKey,
      }
    : options.settings
  const provider = resolveProvider(effectiveSettings)
  const { url, headers } = await buildRequestTarget(provider, effectiveSettings, options.session)

  // Frontier streams again (Phase 0, 2026-06-11). History: the original
  // chat-worker SSE proxy parsed and re-emitted frames, dropping OpenRouter
  // content chunks that straddled `reader.read()` boundaries — that proxy was
  // replaced by a byte-identical passthrough when chat folded into
  // aquilla-identity (2026-05-26; the Phase 0 usage tee is also an identity
  // transform), and consumeStream below buffers split frames correctly. The
  // old `provider !== "frontier"` guard outlived the bug it worked around.
  const useStream = options.stream === true

  // Frontier only: attribute this spend to the project being edited (see
  // activeProjectIdFromPath). Custom OpenAI-compatible endpoints may reject
  // unknown body fields, so the hint is never sent to them.
  const projectId =
    provider === "frontier" ? activeProjectIdFromPath(window.location.pathname) : null

  const request = completionRequestSignal(options.signal, options.timeoutMs)
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({
        model: effectiveSettings.model || "default",
        messages: options.messages,
        max_tokens: effectiveSettings.maxTokens,
        temperature: effectiveSettings.temperature,
        stream: useStream,
        ...(projectId && { projectId }),
      }),
      signal: request.signal,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => "")
      // Frontier returns 402 when subscription/credits are exhausted; surface message.
      if (provider === "frontier" && res.status === 402) {
        throw new Error(`Frontier AI limit reached: ${text || "Out of credits."}`)
      }
      throw new Error(`Completion failed: ${res.status} ${text}`)
    }

    // A/B experiment assignment (frontier default-model traffic only): surface
    // it so the caller can attribute the eventual accept/edit gesture. Optional
    // chaining: some test stubs fake fetch without a headers object.
    const abRequestId = res.headers?.get("X-AB-Request-Id")
    if (abRequestId && options.onAbAssignment) {
      const arm = res.headers.get("X-AB-Arm")
      options.onAbAssignment({
        requestId: abRequestId,
        arm: arm === "challenger" ? "challenger" : "champion",
        model: res.headers.get("X-AB-Model") ?? "",
      })
    }

    if (useStream && options.onChunk && res.body) {
      return consumeStream(res.body, options.onChunk, request.signal)
    }

    const data = await res.json()
    return data.choices[0]?.message?.content?.trim() || ""
  } catch (error) {
    if (request.didTimeout()) {
      throw new Error("The AI request timed out. Please try again.")
    }
    throw error
  } finally {
    request.dispose()
  }
}

const COMPLETION_REQUEST_TIMEOUT_MS = 120_000

function completionRequestSignal(
  externalSignal?: AbortSignal,
  timeoutMs = COMPLETION_REQUEST_TIMEOUT_MS,
): {
  signal: AbortSignal
  didTimeout: () => boolean
  dispose: () => void
} {
  const controller = new AbortController()
  let timedOut = false
  const forwardAbort = () => controller.abort(externalSignal?.reason)
  if (externalSignal?.aborted) forwardAbort()
  else externalSignal?.addEventListener("abort", forwardAbort, { once: true })
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    dispose: () => {
      clearTimeout(timer)
      externalSignal?.removeEventListener("abort", forwardAbort)
    },
  }
}

/**
 * Consume an OpenAI-compatible SSE stream from `/chat/completions`.
 *
 * Two correctness concerns the naive per-chunk split got wrong:
 *   1. SSE events span arbitrary `reader.read()` boundaries — we must buffer
 *      incomplete lines across reads instead of silently losing them.
 *   2. Streaming endpoints return HTTP 200 and embed errors inline
 *      (subscription limits, upstream provider failures). If we only look for
 *      `choices[0].delta.content`, those errors surface as an empty string and
 *      the user sees a blank translation. Detect `data: {"error": ...}` frames
 *      and throw so the caller can surface the message.
 */
async function consumeStream(
  body: ReadableStream<Uint8Array>,
  onChunk: (text: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let full = ""

  const processLine = (line: string): "continue" | "done" => {
    if (!line.startsWith("data: ")) return "continue"
    const payload = line.slice(6).trim()
    if (!payload) return "continue"
    if (payload === "[DONE]") return "done"
    let parsed: {
      choices?: { delta?: { content?: string } }[]
      error?: string | { message?: string }
      message?: string
    }
    try { parsed = JSON.parse(payload) } catch {
      // Shouldn't happen with proper line buffering; log so we notice if upstream changes shape.
      console.warn("[completion] skipped unparseable SSE frame:", payload.slice(0, 200))
      return "continue"
    }
    if (parsed.error) {
      const msg = typeof parsed.error === "string"
        ? (parsed.message || parsed.error)
        : (parsed.error.message || parsed.message || "Completion stream error")
      throw new Error(msg)
    }
    const delta = parsed.choices?.[0]?.delta?.content || ""
    if (delta) {
      full += delta
      onChunk(full)
    }
    return "continue"
  }

  while (true) {
    if (signal?.aborted) {
      reader.cancel().catch(() => { /* ignore */ })
      throw new DOMException("Completion aborted", "AbortError")
    }
    const { done, value } = await reader.read()
    if (done) {
      // Flush any trailing line left in the buffer.
      if (buffer.trim()) processLine(buffer.trim())
      break
    }
    buffer += decoder.decode(value, { stream: true })
    let newlineIdx: number
    while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIdx).replace(/\r$/, "")
      buffer = buffer.slice(newlineIdx + 1)
      if (processLine(line) === "done") return full.trim()
    }
  }
  return full.trim()
}

async function buildRequestTarget(
  provider: CompletionProvider,
  settings: CompletionSettings,
  session: FrontierSession | null,
): Promise<{ url: string; headers: Record<string, string> }> {
  if (provider === "frontier") {
    if (!session?.jwt) {
      throw new Error("Sign in to use Frontier AI.")
    }
    return {
      url: FRONTIER_CHAT_URL,
      headers: { Authorization: `Bearer ${session.jwt}` },
    }
  }
  // custom: local, self-hosted, or third-party OpenAI-compatible (OpenRouter, OpenAI, Groq, ...)
  const customEndpoint = (settings.endpoint ?? "").trim()
  if (!customEndpoint) {
    throw new Error("No custom endpoint configured.")
  }
  const { chatUrl } = normalizeOpenAIBaseUrl(customEndpoint)
  const headers: Record<string, string> = {}
  const key = resolveApiKey("completion", settings.apiKey)
  if (key) headers.Authorization = `Bearer ${key}`
  return { url: chatUrl, headers }
}
