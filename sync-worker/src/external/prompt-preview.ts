// Effective-prompt preview for the Agent API (AQU-1230).
//
//   GET /api/v1/external/projects/:projectId/cells/:cellId/prompt-preview
//     [?targetLang=<lane>]  — '' (default lane) when omitted, same convention
//                             as cells.target_lang / the branching-search route
//     [?fileId=<id>]        — disambiguates a cell_id that exists in more than
//                             one file; otherwise the lowest-ordered match wins
//
// Why this exists: an agent can already PATCH the prompt-shaping settings
// (systemPrompt, completionSettings, translationBrief, rules — see
// commands-patch-settings.ts) but had no way to see what the copilot actually
// receives after injection. Tuning was change-a-setting-then-guess. This route
// closes the loop: it returns the assembled messages plus the labeled parts
// they were built from, so cause→effect is observable.
//
// FIDELITY IS THE WHOLE POINT. This module does not re-implement prompt
// assembly. It gathers the same inputs the editor gathers and hands them to
// the SAME builders (src/lib/completion/prompt-build.ts — extracted from
// completion-service.ts for exactly this) and the SAME retrieval primitive
// (AD-13 branching search, lib/branching-search/*, which the copilot reaches
// through GET /branching-search). Terminology compiles through the shared
// core (src/lib/terminology/compile-core.ts) the editor's compileConceptsToRules
// wraps. If the copilot's assembly changes, this changes with it.
//
// Mirrors `useCompletion.completeSingle` / `prepareSingleEvidence`
// (src/hooks/useCompletion.ts). Two documented departures, both because the
// editor's own value is unavailable or inapplicable server-side:
//   - The corpus for the validated-pair FALLBACK is the cell's FILE (the
//     editor's `cellStore.getAllCellViews()` holds the open file's cells).
//   - No `systemAddendum` / `preSourceBlock`: those come from footnote and
//     IDML decomposition of the live editor buffer. A cell whose source
//     carries USFM footnote markers gets a `warnings` entry saying the real
//     draft call will add a footnote instruction block.
// Per-device provider overrides (user Settings, localStorage) are likewise
// invisible to the server; `generation` reports the PROJECT's configuration.
//
// The system prompt resolves top-level `settings.systemPrompt` first (the key
// PatchSettings writes), then `completionSettings.systemPrompt` (the copy the
// SPA keeps in sync), then DEFAULT_SYSTEM_PROMPT (AQU-1283).
//
// Role floor: VIEWER, same as every other external read — this is a read of
// configuration the caller can already read piecemeal (/projects, settings),
// assembled. It performs no writes and mints no drafts.

import { externalError } from "./errors"
import { targetLaneDualReadBinds, targetLaneDualReadSql } from "../events/lane-id-sql"
import { branchingSearch } from "../lib/branching-search/algorithm"
import { loadCorpus } from "../lib/branching-search/corpus"
import {
  applyBranchingSearchDefaults,
  loadBranchingSearchSettings,
} from "../lib/branching-search/settings"
import { loadProjectSettings } from "../../../db/shared/projects"
import {
  buildBriefBlock,
  buildPrompt,
  buildRulesBlock,
  DEFAULT_APPROVED_EXAMPLE_COUNT,
  DEFAULT_SYSTEM_PROMPT,
  selectApprovedExamples,
  type ChatMessage,
  type PromptRule,
  type ValidatedPair,
} from "../../../src/lib/completion/prompt-build"
import {
  compileConceptsToRulesCore,
  type CompiledConcept,
  type CompileLabels,
} from "../../../src/lib/terminology/compile-core"

/** Ceiling on retrieved few-shot examples, matching the branching-search
 *  route's MAX_TOP_K so a hand-set `top_k` cannot turn a preview into a
 *  full-corpus scan. */
const MAX_TOP_K = 50

/** How many preceding cells to consider when the project has no
 *  `draftContext` setting — DEFAULT_DRAFT_CONTEXT.precedingTargetCells
 *  (src/lib/completion/draft-context.ts). */
const DEFAULT_PRECEDING_TARGET_CELLS = 5

/** Hard cap on the discourse window regardless of the stored setting; the
 *  window is rendered verbatim into the prompt. */
const MAX_PRECEDING_TARGET_CELLS = 50

/**
 * Rule `name`/`description` are display strings and are NOT injected into the
 * prompt (buildRulesBlock reads only `check`), so the worker compiles with
 * plain-English stand-ins rather than pulling the SPA's 2.9 MB i18n catalogs
 * into the bundle. The `check` shapes — the part that reaches the model — are
 * byte-identical to the editor's.
 */
const WORKER_COMPILE_LABELS: CompileLabels = {
  approvedName: (term) => `Terminology: ${term}`,
  approvedDescription: (term, renderings) =>
    `"${term}" must be rendered as one of: ${renderings}`,
  forbiddenName: (term) => `Terminology (forbidden): ${term}`,
  forbiddenDescription: (rendering, term) =>
    `"${rendering}" is a forbidden rendering of "${term}"`,
}

export interface PromptPreviewEnv {
  AQUILLA_PG?: AquillaDb
}

interface CellRow {
  file_id: string
  value: string
  medium: string | null
  transcription: string | null
  sequence_index: number | null
}

interface ContextRow {
  cell_id: string
  value: string
  medium: string | null
  transcription: string | null
  sequence_index: number | null
  target_value: string | null
  target_validated: number | null
}

/**
 * The cell's SEMANTIC source text. Mirrors `effectiveSourceText`
 * (src/lib/cell-text.ts): an imported media section speaks through its
 * TRANSCRIPT — `value` holds the import filename, which is never legitimate
 * source text — so an untranscribed section has none. That module cannot be
 * imported here (its type graph reaches `@/` aliases sync-worker's tsconfig
 * does not map), so the two-line rule is restated; keep them in step.
 */
function effectiveSource(row: {
  value: string
  medium: string | null
  transcription: string | null
}): string {
  if ((row.medium ?? "text") !== "media") return row.value
  return row.transcription?.trim() ? row.transcription : ""
}

/** Read a top-level settings key as a plain object, tolerating junk. */
function objectSetting(
  settings: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const value = settings[key]
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function stringSetting(settings: Record<string, unknown>, key: string): string {
  const value = settings[key]
  return typeof value === "string" ? value : ""
}

/** A prompt-injectable rule that also carries the AQU-609 lane scoping fields.
 *  `TranslationRule` (and the compiled terminology rules) satisfy this. */
type ScopedPromptRule = PromptRule & { scope?: string; lane?: string }

/** Rules stored in a settings blob, defensively narrowed. Anything that is not
 *  a rule-shaped object is dropped rather than 500ing a read. */
function rulesSetting(settings: Record<string, unknown>, key: string): ScopedPromptRule[] {
  const value = settings[key]
  if (!Array.isArray(value)) return []
  return value.filter(
    (r): r is ScopedPromptRule =>
      !!r && typeof r === "object" && "check" in r && "enabled" in r,
  )
}

/** AQU-609 lane filter — the same predicate as `rulesForLane`
 *  (src/lib/rules/rule-engine.ts): lane-scoped rules apply only in their own
 *  lane; org, project, builtin and terminology rules apply in every lane. */
function forLane(rules: ScopedPromptRule[], lane: string): ScopedPromptRule[] {
  return rules.filter((r) => r.scope !== "lane" || (r.lane ?? "") === lane)
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" ? Math.floor(value) : NaN
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/** Labeled description of one injected term, so a caller can see WHICH
 *  terminology entry produced a line in the rules block. */
export interface InjectedTerm {
  conceptId: string
  sourceTerm: string
  approvedRenderings: string[]
  forbiddenRenderings: string[]
}

export interface PromptPreviewBody {
  projectId: string
  fileId: string
  cellId: string
  targetLang: string
  sourceLanguage: string
  targetLanguage: string
  /** The cell's effective source text — what the final `Source:` line carries. */
  sourceText: string
  /** The assembled messages, exactly as the copilot would send them. */
  messages: ChatMessage[]
  /** The same content, labeled by where it came from. */
  parts: {
    /** Base instructions after {sourceLanguage}/{targetLanguage} substitution,
     *  before any injection. */
    base: string
    /** The brief block, or "" when the project has no L1 summary. */
    brief: string
    /** The rules block (terminology + style rules), or "" when nothing injects. */
    rules: string
    injectedTerms: InjectedTerm[]
    examples: ValidatedPair[]
    precedingContext: { source: string; target: string }[]
  }
  /** What the draft call would be made WITH (project configuration; a
   *  per-device provider override in user Settings is invisible here). */
  generation: {
    provider: string
    model: string
    temperature: number | null
    maxTokens: number | null
    exampleFormat: string
    topK: number
  }
  retrieval: {
    /** AD-13 branching search, validated-only, excluding this cell. */
    primitive: "branching-search"
    topK: number
    corpusSize: number
    upstreamProjectId: string | null
    /** Retrieved before the validated-cell fallback filled remaining slots. */
    retrievedCount: number
  }
  /** Non-fatal notes: things the real draft call adds that a read cannot. */
  warnings: { code: string; message: string }[]
}

/**
 * Build the preview. Split from the route handler so tests can drive it
 * against a seeded DB without minting a credential.
 */
export async function buildPromptPreview(
  db: AquillaDb,
  args: { projectId: string; cellId: string; targetLang: string; fileId?: string },
): Promise<{ ok: true; body: PromptPreviewBody } | { ok: false; response: Response }> {
  const { projectId, cellId, targetLang } = args

  // ── the cell itself ──────────────────────────────────────────────────────
  const cellSql =
    "SELECT file_id, value, medium, transcription, sequence_index " +
    "FROM cells WHERE project_id = ? AND cell_id = ? AND side = 'source'" +
    (args.fileId ? " AND file_id = ?" : "") +
    " ORDER BY file_id LIMIT 1"
  const cellBinds: unknown[] = args.fileId
    ? [projectId, cellId, args.fileId]
    : [projectId, cellId]
  const cell = await db.prepare(cellSql).bind(...cellBinds).first<CellRow>()
  if (!cell) {
    return {
      ok: false,
      response: externalError("not_found", "no source cell with that id in this project", 404),
    }
  }
  const fileId = cell.file_id
  const sourceText = effectiveSource(cell)

  // ── settings ─────────────────────────────────────────────────────────────
  const { settings } = await loadProjectSettings(db, projectId)
  const completion = objectSetting(settings, "completionSettings")
  const brief = objectSetting(settings, "translationBrief")
  const draftContext = objectSetting(settings, "draftContext")

  const sourceLanguage = stringSetting(settings, "sourceLanguage")
  // Default lane inherits the project target language; a named lane IS its own
  // target language (resolveActiveTargetLanguage, project-workspace-lane-target.ts).
  const targetLanguage = targetLang || stringSetting(settings, "targetLanguage")

  // Top-level `systemPrompt` is what PatchSettings writes and what the SPA
  // syncs into completionSettings.systemPrompt (useProject.ts) — so it wins;
  // the nested copy is the fallback for projects that only ever set it there.
  const systemPrompt =
    stringSetting(settings, "systemPrompt") ||
    stringSetting(completion, "systemPrompt") ||
    DEFAULT_SYSTEM_PROMPT
  const topK = clampInt(completion.top_k, DEFAULT_APPROVED_EXAMPLE_COUNT, 1, MAX_TOP_K)
  const exampleFormat =
    completion.fewShotExampleFormat === "target-only" ? "target-only" : "source-and-target"
  const briefSummary = stringSetting(brief, "l1Summary")
  const precedingCount = clampInt(
    draftContext.precedingTargetCells,
    DEFAULT_PRECEDING_TARGET_CELLS,
    0,
    MAX_PRECEDING_TARGET_CELLS,
  )

  // ── rules: org → project → terminology, then the lane filter ─────────────
  // Builtin (algorithmic) checks are deliberately absent: buildRulesBlock
  // renders no text for them, so including them would change nothing in the
  // prompt while requiring the builtin resolver here.
  const orgRow = await db
    .prepare(
      "SELECT os.settings AS settings FROM org_settings os " +
        "JOIN projects p ON p.org_id = os.org_id WHERE p.id = ?",
    )
    .bind(projectId)
    .first<{ settings: string }>()
  let orgSettings: Record<string, unknown> = {}
  if (orgRow?.settings) {
    try {
      const parsed: unknown = JSON.parse(orgRow.settings)
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        orgSettings = parsed as Record<string, unknown>
      }
    } catch {
      // Non-JSON org settings — treat as none rather than failing the read.
    }
  }

  // This project's OWN concepts, from the sync-worker projection (the
  // `terminology` settings key is gone — see useRules' localConcepts note).
  // Termbase SUBSCRIPTIONS are intentionally not compiled in: the client
  // passes `subscribedConcepts: undefined` today because the upstream
  // termbase-read route does not exist yet (useSubscribedConcepts' SWARM-TODO),
  // so including them here would make the preview diverge from the real call.
  const conceptRows = await db
    .prepare(
      "SELECT concept_id, source_term, renderings, status, case_sensitive " +
        "FROM concepts WHERE project_id = ? AND deleted_at IS NULL ORDER BY concept_id",
    )
    .bind(projectId)
    .all<{
      concept_id: string
      source_term: string
      renderings: unknown
      status: string
      case_sensitive: number
    }>()

  const concepts: CompiledConcept[] = conceptRows.results.map((row) => {
    const parsed: unknown =
      typeof row.renderings === "string" ? safeJson(row.renderings) : row.renderings
    const renderings = Array.isArray(parsed)
      ? parsed.filter(
          (r): r is { rendering: string; status: string } =>
            !!r &&
            typeof r === "object" &&
            typeof (r as { rendering?: unknown }).rendering === "string" &&
            typeof (r as { status?: unknown }).status === "string",
        )
      : []
    return {
      id: row.concept_id,
      sourceTerm: row.source_term,
      renderings,
      status: row.status,
      ...(row.case_sensitive ? { caseSensitive: true } : {}),
    }
  })

  const terminologyRules = compileConceptsToRulesCore(concepts, WORKER_COMPILE_LABELS)
  const rules: ScopedPromptRule[] = forLane(
    [
      ...rulesSetting(orgSettings, "rules"),
      ...rulesSetting(settings, "rules"),
      ...terminologyRules,
    ],
    targetLang,
  )

  const injectedTerms: InjectedTerm[] = concepts
    .filter((c) => c.status === "active")
    .map((c) => ({
      conceptId: c.id,
      sourceTerm: c.sourceTerm,
      approvedRenderings: c.renderings
        .filter((r) => r.status === "preferred" || r.status === "admitted")
        .map((r) => r.rendering),
      forbiddenRenderings: c.renderings
        .filter((r) => r.status === "forbidden")
        .map((r) => r.rendering),
    }))

  // ── discourse window (D4): the approved target of preceding cells ────────
  const precedingContext = precedingCount
    ? await loadPrecedingContext(db, {
        projectId,
        fileId,
        cellId,
        targetLang,
        count: precedingCount,
        sequenceIndex: cell.sequence_index,
      })
    : []

  // ── retrieval: AD-13 branching search, exactly as the copilot calls it ───
  let retrieved: ValidatedPair[] = []
  let corpusSize = 0
  let upstreamProjectId: string | null = null
  if (sourceText.trim()) {
    const searchSettings = applyBranchingSearchDefaults({
      ...(await loadBranchingSearchSettings({ AQUILLA_PG: db }, projectId)),
      topK,
    })
    const corpus = await loadCorpus(
      { AQUILLA_PG: db },
      { projectId, validatedOnly: true, excludeCellId: cellId, targetLang },
    )
    corpusSize = corpus.cells.length
    upstreamProjectId = corpus.upstreamProjectId
    retrieved = branchingSearch(sourceText, corpus.cells, searchSettings).results.map((r) => ({
      cellId: r.cellId,
      source: r.sourceText,
      target: r.targetText,
    }))
  }

  // The editor's local fallback: validated pairs from the open file's cells,
  // ranked by token overlap with the source. Only fills slots retrieval left.
  const fallback = await loadValidatedFallback(db, {
    projectId,
    fileId,
    cellId,
    targetLang,
    query: sourceText,
    limit: topK * 2,
  })

  const examples = selectApprovedExamples(retrieved, fallback, topK, [
    ...precedingContext,
    { source: sourceText },
  ])

  const messages = buildPrompt({
    sourceLanguage,
    targetLanguage,
    systemPrompt,
    sourceText,
    examples: [],
    rules,
    validatedPairs: examples,
    exampleFormat,
    briefSummary,
    precedingContext,
  })

  const warnings: { code: string; message: string }[] = []
  if (!sourceText.trim()) {
    warnings.push({
      code: "empty_source",
      message:
        "this cell has no effective source text (an untranscribed media section, or an empty cell) — " +
        "the copilot refuses to draft it, and retrieval was skipped",
    })
  }
  if (/\\f\s/.test(sourceText) || sourceText.includes("\\f*")) {
    warnings.push({
      code: "footnote_addendum_not_previewed",
      message:
        "source carries USFM footnote markers — the real draft call decomposes them and appends a " +
        "footnote output contract to the system prompt (buildFootnoteInstruction), which this read cannot reproduce",
    })
  }

  return {
    ok: true,
    body: {
      projectId,
      fileId,
      cellId,
      targetLang,
      sourceLanguage,
      targetLanguage,
      sourceText,
      messages,
      parts: {
        base: systemPrompt
          .replace(/\{sourceLanguage\}/g, sourceLanguage)
          .replace(/\{targetLanguage\}/g, targetLanguage),
        brief: buildBriefBlock(briefSummary),
        rules: buildRulesBlock(rules),
        injectedTerms,
        examples,
        precedingContext,
      },
      generation: {
        provider:
          typeof completion.provider === "string" && completion.provider
            ? completion.provider
            : stringSetting(completion, "endpoint").trim()
              ? "custom"
              : "frontier",
        model: stringSetting(completion, "model"),
        temperature: typeof completion.temperature === "number" ? completion.temperature : null,
        maxTokens: typeof completion.maxTokens === "number" ? completion.maxTokens : null,
        exampleFormat,
        topK,
      },
      retrieval: {
        primitive: "branching-search",
        topK,
        corpusSize,
        upstreamProjectId,
        retrievedCount: retrieved.length,
      },
      warnings,
    },
  }
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/**
 * The approved target of up to `count` cells immediately preceding `cellId` in
 * the same file, in document order — `gatherPrecedingContext`
 * (src/lib/completion/draft-context.ts) expressed as SQL. Cells with no
 * effective source, or with no VALIDATED target, are skipped: unapproved
 * target text is never prompt context.
 */
async function loadPrecedingContext(
  db: AquillaDb,
  args: {
    projectId: string
    fileId: string
    cellId: string
    targetLang: string
    count: number
    sequenceIndex: number | null
  },
): Promise<{ source: string; target: string }[]> {
  // A null sequence_index means the projection never ordered this cell; there
  // is no "preceding" to speak of, so the window is empty rather than wrong.
  if (args.sequenceIndex === null) return []

  const rows = await db
    .prepare(
      "SELECT s.cell_id AS cell_id, s.value AS value, s.medium AS medium, " +
        "s.transcription AS transcription, s.sequence_index AS sequence_index, " +
        "t.value AS target_value, t.validated AS target_validated " +
        "FROM cells s " +
        "LEFT JOIN cells t ON t.project_id = s.project_id AND t.file_id = s.file_id " +
        "  AND t.cell_id = s.cell_id AND t.side = 'target' AND " +
        targetLaneDualReadSql("t") +
        " " +
        "WHERE s.project_id = ? AND s.file_id = ? AND s.side = 'source' " +
        "  AND s.sequence_index IS NOT NULL AND s.sequence_index < ? " +
        "  AND t.validated = 1 AND t.value != '' " +
        "ORDER BY s.sequence_index DESC LIMIT ?",
    )
    .bind(
      ...targetLaneDualReadBinds(args.projectId, args.targetLang),
      args.projectId,
      args.fileId,
      args.sequenceIndex,
      args.count,
    )
    .all<ContextRow>()

  return rows.results
    .map((row) => ({ source: effectiveSource(row), target: row.target_value ?? "" }))
    .filter((pair) => pair.source.trim() && pair.target.trim())
    .reverse() // restore document order (oldest → newest)
}

/**
 * Validated source→target pairs from the cell's file, ranked by token overlap
 * with the query — `collectValidatedPairs` (completion-service.ts) over the
 * editor's open-file cell store, expressed against the projection. Ranking is
 * done in TS on a bounded row set so the overlap rule stays identical to the
 * client's (whitespace/punctuation split, lower-cased, unique query tokens).
 */
async function loadValidatedFallback(
  db: AquillaDb,
  args: {
    projectId: string
    fileId: string
    cellId: string
    targetLang: string
    query: string
    limit: number
  },
): Promise<ValidatedPair[]> {
  if (args.limit <= 0) return []
  const rows = await db
    .prepare(
      "SELECT s.cell_id AS cell_id, s.value AS value, s.medium AS medium, " +
        "s.transcription AS transcription, s.sequence_index AS sequence_index, " +
        "t.value AS target_value, t.validated AS target_validated " +
        "FROM cells s " +
        "JOIN cells t ON t.project_id = s.project_id AND t.file_id = s.file_id " +
        "  AND t.cell_id = s.cell_id AND t.side = 'target' AND " +
        targetLaneDualReadSql("t") +
        " " +
        "WHERE s.project_id = ? AND s.file_id = ? AND s.side = 'source' " +
        "  AND s.cell_id != ? AND t.validated = 1 AND t.value != '' " +
        "ORDER BY s.sequence_index NULLS LAST, s.cell_id " +
        // Bounded scan: the client ranks its whole open file, but the file can
        // be tens of thousands of cells. 20x the requested limit is a wide
        // enough net for token overlap while staying a cheap query.
        "LIMIT ?",
    )
    .bind(
      ...targetLaneDualReadBinds(args.projectId, args.targetLang),
      args.projectId,
      args.fileId,
      args.cellId,
      Math.min(2000, args.limit * 20),
    )
    .all<ContextRow>()

  const pairs = rows.results
    .map((row) => ({
      cellId: row.cell_id,
      source: effectiveSource(row),
      target: row.target_value ?? "",
    }))
    .filter((p) => p.source.trim() && p.target.trim())

  const query = args.query.trim()
  if (!query) return pairs.slice(0, args.limit)

  const queryTokens = new Set(query.toLowerCase().split(/[\s\p{P}]+/u).filter(Boolean))
  return pairs
    .map((pair) => ({
      pair,
      overlap: pair.source
        .toLowerCase()
        .split(/[\s\p{P}]+/u)
        .filter(Boolean)
        .filter((token) => queryTokens.has(token)).length,
    }))
    // Stable sort (ES2019+): equal-overlap pairs keep document order, matching
    // the client's Array#sort over its already-ordered cell list.
    .sort((a, b) => b.overlap - a.overlap)
    .slice(0, args.limit)
    .map((scored) => scored.pair)
}

/** Route handler. Auth/scope/rate-limit are applied by the caller in
 *  read-routes.ts, which owns the external read perimeter. */
export async function handlePromptPreview(
  request: Request,
  env: PromptPreviewEnv,
  projectId: string,
  cellId: string,
): Promise<Response> {
  if (!env.AQUILLA_PG) return externalError("job_failed", "AQUILLA_PG not configured", 500)
  const url = new URL(request.url)
  const targetLang = url.searchParams.get("targetLang") ?? ""
  const fileId = url.searchParams.get("fileId") ?? undefined

  const result = await buildPromptPreview(env.AQUILLA_PG, {
    projectId,
    cellId,
    targetLang,
    ...(fileId ? { fileId } : {}),
  })
  if (!result.ok) return result.response
  return Response.json(result.body)
}
