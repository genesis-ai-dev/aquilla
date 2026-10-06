// Project context — everything an expert translator would have on the desk
// before drafting a line, assembled server-side for the autopilot run.
//
// The gap this closes: a project's TERMINOLOGY (its key-term decisions — which
// rendering of "grace" or "covenant" this team standardised on, and which ones
// are forbidden) was compiled into rules CLIENT-SIDE ONLY, by `useRules` on
// read. Nothing on the server ever saw it. So autopilot drafted every passage
// blind to the single most consequential professional constraint in the
// project, and its lint could not catch a violation it had never been told
// about. Same for the translation brief: only the compressed L1 summary
// reached the model, and only if somebody had generated one — the structured
// skopos parameters (register, literalness, key-term strategy, constraints,
// quality bar) sat unused in the same settings blob.
//
// The brief and the rules are read from ONE `project_settings` row. The
// project's own key terms come from the `concepts` table, where the editor
// reads them (AQU-1710). Terminology hits reuse the client's compiled rule ids
// (`term:<conceptId>:…`), so a server-side finding and the browser's
// violations inbox point at the same concept rather than at two definitions
// that drift.

import {
  compileRulePattern,
  countMatches,
  ruleViolation,
  type LintHit,
  type LintRule,
  type RuleViolation,
} from "../agent/lint"
import {
  compileConceptsToRulesCore,
  type CompileLabels,
  type CompiledTermRule,
} from "../../../../src/lib/terminology/compile-core"
import { conceptToRegexSource } from "../../../../src/lib/terminology/match"
import { coerceMatchOptions } from "../../../../src/lib/terminology/match-options"
import type { TermMatchOptions, TermMatchingSettings } from "../../../../src/lib/terminology/model"

// ── Shapes (mirrors of src/lib/terminology/types.ts + src/lib/brief/types.ts) ─

export type RenderingStatus = "preferred" | "admitted" | "forbidden"

export interface TermRendering {
  rendering: string
  status: RenderingStatus
}

export interface Concept {
  id: string
  sourceTerm: string
  renderings: TermRendering[]
  notes?: string
  status: "active" | "draft" | "deprecated"
  /** Read as the editor reads them (AQU-1710) and matched as the editor
   *  matches them (AQU-1711). */
  caseSensitive?: boolean
  match?: TermMatchOptions
}

export interface TranslationBriefParameters {
  purpose?: string
  audience?: string
  useAndMedium?: string
  motiveSponsor?: string
  sourceTexts?: string
  targetVariety?: string
  registerNaturalness?: string
  literalness?: string
  keyTerms?: string
  constraints?: string
  qualityBar?: string
  [k: string]: string | undefined
}

/** Brief fields that change how a line is WORDED, in prompt order. The purpose
 *  group (motive, sponsor) matters to humans planning the work but does not
 *  alter a rendering, so it stays out of the performer's context budget. */
export const PERFORMER_BRIEF_FIELDS: { id: string; label: string }[] = [
  { id: "audience", label: "Audience" },
  { id: "useAndMedium", label: "Use & medium" },
  { id: "targetVariety", label: "Variety & orthography" },
  { id: "registerNaturalness", label: "Register & naturalness" },
  { id: "literalness", label: "Literalness" },
  { id: "keyTerms", label: "Key-term strategy" },
  { id: "constraints", label: "Constraints & sensitivities" },
  { id: "qualityBar", label: "Quality bar" },
]

/** Per-field clip so a rambling brief cannot crowd out the scene itself. */
const BRIEF_FIELD_MAX_CHARS = 400

export interface TermGuidance {
  conceptId: string
  sourceTerm: string
  preferred: string[]
  admitted: string[]
  forbidden: string[]
  notes?: string
}

export interface ProjectContext {
  sourceLanguage?: string
  targetLanguage?: string
  /** Model-generated compression of the whole brief, when one exists. */
  projectBriefL1?: string
  /** The brief's structured answers — used verbatim when there is no L1. */
  briefParameters: TranslationBriefParameters
  /** Active concepts, the project's own plus any it subscribes to. */
  concepts: Concept[]
  /** The project's affix inventory for source-term matching
   *  (ProjectWideSettings.termMatching), as the editor applies it. */
  termMatching?: TermMatchingSettings
  /** Hand-authored project rules. */
  authoredRules: LintRule[]
}

// ── Parsing ─────────────────────────────────────────────────────────────────

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined
}

function parseConcepts(raw: unknown): Concept[] {
  if (!Array.isArray(raw)) return []
  const out: Concept[] = []
  for (const item of raw) {
    if (!item || typeof item !== "object") continue
    const c = item as Record<string, unknown>
    if (typeof c.id !== "string" || typeof c.sourceTerm !== "string") continue
    if (c.status !== "active") continue // draft/deprecated never constrain a draft
    const renderings: TermRendering[] = []
    if (Array.isArray(c.renderings)) {
      for (const r of c.renderings) {
        if (!r || typeof r !== "object") continue
        const rr = r as Record<string, unknown>
        if (typeof rr.rendering !== "string" || !rr.rendering.trim()) continue
        if (rr.status !== "preferred" && rr.status !== "admitted" && rr.status !== "forbidden") continue
        renderings.push({ rendering: rr.rendering.trim(), status: rr.status })
      }
    }
    const match = coerceMatchOptions(c.match)
    out.push({
      id: c.id,
      sourceTerm: c.sourceTerm,
      renderings,
      status: "active",
      ...(asString(c.notes) ? { notes: asString(c.notes) } : {}),
      ...(c.caseSensitive === true ? { caseSensitive: true } : {}),
      ...(match ? { match } : {}),
    })
  }
  return out
}

function parseAuthoredRules(raw: unknown): LintRule[] {
  if (!Array.isArray(raw)) return []
  return raw.filter(
    (r): r is LintRule =>
      !!r && typeof r === "object" && typeof (r as LintRule).id === "string" &&
      (r as LintRule).enabled === true && !!(r as LintRule).check,
  )
}

function parseBriefParameters(raw: unknown): TranslationBriefParameters {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {}
  const out: TranslationBriefParameters = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const s = asString(v)
    if (s) out[k] = s.slice(0, BRIEF_FIELD_MAX_CHARS)
  }
  return out
}

/** `ProjectWideSettings.termMatching`, which the editor passes to the matcher
 *  as stored. Only the types are checked here, so a malformed value cannot
 *  throw inside the matcher in the middle of a run. */
function parseTermMatching(raw: unknown): TermMatchingSettings | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined
  const r = raw as Record<string, unknown>
  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : []
  return {
    prefixes: strings(r.prefixes),
    suffixes: strings(r.suffixes),
    ...(typeof r.maxAffixes === "number" ? { maxAffixes: r.maxAffixes } : {}),
    ...(typeof r.foldMarksDefault === "boolean" ? { foldMarksDefault: r.foldMarksDefault } : {}),
  }
}

// ── Terminology checking ────────────────────────────────────────────────────

/** Names for the compiled term rules. Hits carry them to the model, so they
 *  name the term and its renderings, never the regex. */
const TERM_LABELS: CompileLabels = {
  approvedName: (term) => `Term: ${term}`,
  approvedDescription: (term, renderings) => `"${term}" must use an approved rendering (${renderings})`,
  forbiddenName: (term) => `Term: ${term} — forbidden rendering`,
  forbiddenDescription: (rendering, term) => `"${rendering}" is a forbidden rendering for "${term}"`,
}

function termMessage(rule: CompiledTermRule, violation: RuleViolation): string {
  // Renderings are present but too few or too many: say which, so the model
  // knows whether to add one or remove one.
  if (violation.type === "source-requires-target" && violation.targetCount > 0) {
    return `${rule.description}, once each time the term appears: ×${violation.sourceCount} in the source, ×${violation.targetCount} in the target`
  }
  return rule.description
}

interface ConceptCheck {
  concept: Concept
  /** The rules the editor compiles from the concept (compile-core.ts). */
  rules: CompiledTermRule[]
  /** The concept's source pattern, with its rules' flags. Null when it
   *  compiles to no rules or the pattern is invalid. */
  source: RegExp | null
}

// Compiled once per termbase per run: `ctx.concepts` is one array for a whole
// tick, so every cell, span and redraft reuses it. Compiling per cell cost
// ~9 ms per cell on a 961-term termbase, and ~30 ms with an affix inventory.
const conceptChecks = new WeakMap<Concept[], { termMatching?: TermMatchingSettings; checks: ConceptCheck[] }>()

function checksFor(concepts: Concept[], termMatching?: TermMatchingSettings): ConceptCheck[] {
  const cached = conceptChecks.get(concepts)
  if (cached && cached.termMatching === termMatching) return cached.checks
  const checks = concepts.map((concept): ConceptCheck => {
    const rules = compileConceptsToRulesCore([concept], TERM_LABELS, termMatching)
    const pattern = rules.length > 0 ? conceptToRegexSource(concept, termMatching) : null
    return { concept, rules, source: pattern === null ? null : compileRulePattern(rules[0], pattern) }
  })
  conceptChecks.set(concepts, { termMatching, checks })
  return checks
}

/**
 * Check one drafted cell against the project's key terms with the rules the
 * editor compiles from them (src/lib/terminology/compile-core.ts), judged as
 * the editor judges them (`ruleViolation`, AQU-1711). Both sides run the
 * shared table in src/lib/terminology/__fixtures__/terminology-lint-parity.ts.
 *
 * One deliberate difference: a forbidden rendering counts only when the
 * cell's SOURCE bears the concept. That is the intended rule; the editor's
 * `target-forbids` has no source condition yet (AQU-1712).
 *
 * Hit ids are the client's compiled rule ids (`term:<conceptId>:approved`,
 * `term:<conceptId>:forbidden:<rendering>`) so findings stay attributable to
 * the same concept in the violations inbox.
 */
export function lintTerminology(
  concepts: Concept[],
  sourceText: string,
  targetText: string,
  termMatching?: TermMatchingSettings,
): LintHit[] {
  // Like the editor, terminology does not judge an empty translation.
  if (!targetText.trim()) return []
  const hits: LintHit[] = []
  for (const { rules, source } of checksFor(concepts, termMatching)) {
    // The concept constrains only a cell whose source bears it: the same
    // pattern and flags as its approved rule's source side.
    if (!source || countMatches(sourceText, source) === 0) continue
    for (const rule of rules) {
      const violation = ruleViolation(rule, sourceText, targetText)
      if (violation) hits.push({ ruleId: rule.id, ruleName: rule.name, message: termMessage(rule, violation) })
    }
  }
  return hits
}

// ── Span-scoped term guidance ───────────────────────────────────────────────

/** Ceiling on terms carried into one prompt. Ordered by first appearance in
 *  the span, so the cut falls on the least locally-relevant entries. */
export const MAX_TERMS_PER_SPAN = 24

/**
 * The concepts whose source term actually appears in THIS span's source text.
 *
 * Sending the whole termbase would be both expensive and counterproductive: a
 * 900-entry glossary buries the eight terms that matter for this passage. The
 * span is the natural scope — it is exactly what a translator would look up
 * before drafting these verses.
 */
export function termGuidanceForSpan(
  concepts: Concept[],
  sourceTexts: string[],
  termMatching?: TermMatchingSettings,
): TermGuidance[] {
  if (concepts.length === 0) return []
  const haystack = sourceTexts.join("\n")
  if (!haystack.trim()) return []

  const hits: { at: number; guidance: TermGuidance }[] = []
  for (const { concept, source } of checksFor(concepts, termMatching)) {
    // Found with the lint's own pattern, so the model is told about exactly
    // the terms the lint checks (AQU-1711). `search` leaves `source` reusable.
    const at = source ? haystack.search(source) : -1
    if (at < 0) continue
    const preferred = concept.renderings.filter((r) => r.status === "preferred").map((r) => r.rendering)
    const admitted = concept.renderings.filter((r) => r.status === "admitted").map((r) => r.rendering)
    const forbidden = concept.renderings.filter((r) => r.status === "forbidden").map((r) => r.rendering)
    // A concept with no decisions recorded yet constrains nothing.
    if (preferred.length === 0 && admitted.length === 0 && forbidden.length === 0) continue
    hits.push({
      at,
      guidance: {
        conceptId: concept.id,
        sourceTerm: concept.sourceTerm,
        preferred,
        admitted,
        forbidden,
        ...(concept.notes ? { notes: concept.notes } : {}),
      },
    })
  }
  return hits
    .sort((a, b) => a.at - b.at)
    .slice(0, MAX_TERMS_PER_SPAN)
    .map((h) => h.guidance)
}

// ── Loading ─────────────────────────────────────────────────────────────────

interface SettingsDb {
  prepare(query: string): {
    bind(...params: unknown[]): {
      first<T>(): Promise<T | null>
      all<T>(): Promise<{ results: T[] }>
    }
  }
}

interface SettingsRow {
  settings: unknown
  source_language: string | null
  target_language: string | null
}

function parseSettings(raw: unknown): Record<string, unknown> {
  if (!raw) return {}
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as unknown
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {}
    } catch {
      return {}
    }
  }
  return typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
}

/**
 * Load everything the performer should know about this project.
 *
 * Best-effort throughout: a project with no brief, no terminology, and no
 * rules still drafts — it just drafts with less to go on, which is what the
 * readiness report exists to make visible BEFORE someone presses play.
 */
export async function loadProjectContext(
  db: SettingsDb,
  projectId: string,
): Promise<ProjectContext> {
  const empty: ProjectContext = {
    briefParameters: {},
    concepts: [],
    authoredRules: [],
  }
  let row: SettingsRow | null = null
  try {
    row = await db
      .prepare(
        `SELECT settings, source_language, target_language
           FROM project_settings WHERE project_id = ?`,
      )
      .bind(projectId)
      .first<SettingsRow>()
  } catch {
    return empty
  }
  if (!row) return empty

  const settings = parseSettings(row.settings)
  const brief = settings.translationBrief
  const briefObj =
    brief && typeof brief === "object" && !Array.isArray(brief)
      ? (brief as Record<string, unknown>)
      : {}

  const concepts = [
    ...(await loadLocalConcepts(db, projectId, settings.terminology)),
    ...(await loadSubscribedConcepts(db, projectId)),
  ]
  const termMatching = parseTermMatching(settings.termMatching)

  return {
    ...(asString(row.source_language) ? { sourceLanguage: asString(row.source_language) } : {}),
    ...(asString(row.target_language) ? { targetLanguage: asString(row.target_language) } : {}),
    ...(asString(briefObj.l1Summary) ? { projectBriefL1: asString(briefObj.l1Summary) } : {}),
    briefParameters: parseBriefParameters(briefObj.parameters),
    concepts,
    ...(termMatching ? { termMatching } : {}),
    authoredRules: parseAuthoredRules(settings.rules),
  }
}

function stringList(raw: unknown): string[] {
  return Array.isArray(raw)
    ? raw.filter((item): item is string => typeof item === "string" && item.trim() !== "")
    : []
}

/** Empty string is always the project-default lane. Named lanes must be
 *  registered in settings.targetLanes and not archived. */
export async function isRegisteredTargetLane(
  db: SettingsDb,
  projectId: string,
  lane: string,
): Promise<boolean> {
  if (lane === "") return true
  try {
    const row = await db
      .prepare(`SELECT settings FROM project_settings WHERE project_id = ?`)
      .bind(projectId)
      .first<{ settings: unknown }>()
    if (!row) return false
    const settings = parseSettings(row.settings)
    const lanes = stringList(settings.targetLanes)
    const archived = stringList(settings.archivedLanes)
    return lanes.includes(lane) && !archived.includes(lane)
  } catch {
    return false
  }
}

interface ConceptRow {
  concept_id: string
  source_term: string
  renderings: unknown
  notes: string | null
  status: string
  case_sensitive: number
  match_options: unknown
}

/** A JSONB column can arrive parsed or as text, depending on the driver. */
function jsonColumn(raw: unknown): unknown {
  if (typeof raw !== "string") return raw
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return undefined
  }
}

/**
 * The project's own concepts, read where the editor reads them (AQU-1710): the
 * live rows of the `concepts` projection. `term.*` events have written there
 * since 2026-09-04, and `migrateProjectConcepts` deletes the old `terminology`
 * settings key once it has copied it, so reading only the key gave every
 * migrated project an empty termbase. As in the editor's read route
 * (sync-worker/src/events/concepts-read-route.ts), the key is a fallback only
 * when the table has no live rows, so a leftover blob never adds to the table.
 */
async function loadLocalConcepts(db: SettingsDb, projectId: string, blob: unknown): Promise<Concept[]> {
  let rows: ConceptRow[]
  try {
    const { results } = await db
      .prepare(
        `SELECT concept_id, source_term, renderings, notes, status, case_sensitive, match_options
           FROM concepts
          WHERE project_id = ? AND deleted_at IS NULL
          ORDER BY created_at ASC`,
      )
      .bind(projectId)
      .all<ConceptRow>()
    rows = results
  } catch (err) {
    // Draft without terms rather than fail the run, but say so: a silently
    // empty termbase is the failure this read exists to end.
    console.warn(
      `[contextual] concepts read failed for project ${projectId}; drafting without its key terms:`,
      err instanceof Error ? err.message : err,
    )
    return []
  }
  if (rows.length === 0) return parseConcepts(blob)
  return parseConcepts(
    rows.map((r) => ({
      id: r.concept_id,
      sourceTerm: r.source_term,
      renderings: jsonColumn(r.renderings),
      notes: r.notes,
      status: r.status,
      caseSensitive: r.case_sensitive === 1,
      match: jsonColumn(r.match_options),
    })),
  )
}

/** Concepts from termbases this project subscribes to, in priority order.
 *  An org that publishes one shared termbase expects it to bind everywhere. */
async function loadSubscribedConcepts(db: SettingsDb, projectId: string): Promise<Concept[]> {
  try {
    const { results } = await db
      .prepare(
        `SELECT ps.settings
           FROM project_termbase_subscriptions s
           JOIN project_settings ps ON ps.project_id = s.termbase_project_id
          WHERE s.project_id = ?
          ORDER BY s.priority ASC`,
      )
      .bind(projectId)
      .all<{ settings: unknown }>()
    return results.flatMap((r) => parseConcepts(parseSettings(r.settings).terminology))
  } catch {
    return []
  }
}
