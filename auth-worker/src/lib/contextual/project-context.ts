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
// Everything here is read from ONE `project_settings` row. Terminology hits
// reuse the client's compiled rule ids (`term:<conceptId>:…`), so a server-side
// finding and the browser's violations inbox point at the same concept rather
// than at two definitions that drift.

import { termToRegexSource, type LintHit, type LintRule } from "../agent/lint"

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
    out.push({
      id: c.id,
      sourceTerm: c.sourceTerm,
      renderings,
      status: "active",
      ...(asString(c.notes) ? { notes: asString(c.notes) } : {}),
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

// ── Terminology checking ────────────────────────────────────────────────────

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function buildTermRegex(term: string): RegExp | null {
  const src = termToRegexSource(term)
  if (src === null) return null
  try {
    return new RegExp(src, "iu")
  } catch {
    return null // malformed user pattern — never break drafting over it
  }
}

function termMatches(haystack: string, term: string): boolean {
  if (!haystack) return false
  const re = buildTermRegex(term)
  return re !== null && re.test(haystack)
}

/**
 * Check one drafted cell against the project's key terms.
 *
 * Deliberately NOT expressed as `LintRule`s run through `lintDraft`. That
 * path's checks compare a single pattern at a time, so "the target must
 * contain AT LEAST ONE of these three approved renderings" cannot be stated in
 * it — an alternation would be escaped as a literal and silently never match,
 * which is the worst possible failure for a check whose whole job is catching
 * silent inconsistency. The any-of test lives here instead.
 *
 * Hit ids match the client's compiled rule ids (`term:<conceptId>:approved`,
 * `term:<conceptId>:forbidden:<rendering>`) so findings stay attributable to
 * the same concept in the violations inbox.
 */
export function lintTerminology(
  concepts: Concept[],
  sourceText: string,
  targetText: string,
): LintHit[] {
  if (!targetText) return []
  const hits: LintHit[] = []
  for (const concept of concepts) {
    // The concept only constrains a cell whose SOURCE bears the term.
    if (!termMatches(sourceText, concept.sourceTerm)) continue

    const approved = concept.renderings.filter(
      (r) => r.status === "preferred" || r.status === "admitted",
    )
    if (approved.length > 0 && !approved.some((r) => termMatches(targetText, r.rendering))) {
      hits.push({
        ruleId: `term:${concept.id}:approved`,
        ruleName: `Term: ${concept.sourceTerm}`,
        message: `"${concept.sourceTerm}" must use an approved rendering (${approved.map((r) => r.rendering).join(", ")})`,
      })
    }
    for (const f of concept.renderings.filter((r) => r.status === "forbidden")) {
      if (termMatches(targetText, f.rendering)) {
        hits.push({
          ruleId: `term:${concept.id}:forbidden:${escapeRegex(f.rendering)}`,
          ruleName: `Term: ${concept.sourceTerm} — forbidden rendering`,
          message: `"${f.rendering}" is a forbidden rendering for "${concept.sourceTerm}"`,
        })
      }
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
): TermGuidance[] {
  if (concepts.length === 0) return []
  const haystack = sourceTexts.join("\n")
  if (!haystack.trim()) return []

  const hits: { at: number; guidance: TermGuidance }[] = []
  for (const concept of concepts) {
    const re = buildTermRegex(concept.sourceTerm)
    if (!re) continue
    const match = re.exec(haystack)
    if (!match) continue
    const preferred = concept.renderings.filter((r) => r.status === "preferred").map((r) => r.rendering)
    const admitted = concept.renderings.filter((r) => r.status === "admitted").map((r) => r.rendering)
    const forbidden = concept.renderings.filter((r) => r.status === "forbidden").map((r) => r.rendering)
    // A concept with no decisions recorded yet constrains nothing.
    if (preferred.length === 0 && admitted.length === 0 && forbidden.length === 0) continue
    hits.push({
      at: match.index,
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
    ...parseConcepts(settings.terminology),
    ...(await loadSubscribedConcepts(db, projectId)),
  ]

  return {
    ...(asString(row.source_language) ? { sourceLanguage: asString(row.source_language) } : {}),
    ...(asString(row.target_language) ? { targetLanguage: asString(row.target_language) } : {}),
    ...(asString(briefObj.l1Summary) ? { projectBriefL1: asString(briefObj.l1Summary) } : {}),
    briefParameters: parseBriefParameters(briefObj.parameters),
    concepts,
    authoredRules: parseAuthoredRules(settings.rules),
  }
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
