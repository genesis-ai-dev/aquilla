// AQU-1192: project-wide terminology scans that used to run in the browser
// after downloading every verse. The worker walks the cells projection once
// and returns only the result.

import { extractCandidates } from "../../../src/lib/terminology/candidates"
import { predictEquivalents } from "../../../src/lib/terminology/equivalents"
import { buildConceptRegex, matchesTerm } from "../../../src/lib/terminology/match"
import type { ConceptMatchInput, TermMatchingSettings } from "../../../src/lib/terminology/model"
import type {
  TerminologyCandidateRow,
  TerminologyCandidatesPage,
  TerminologyViolationKind,
  TerminologyViolationRow,
  TerminologyViolationsPage,
} from "../../../src/lib/terminology/project-scan"
import type { Concept } from "../../../src/lib/terminology/types"
import type { PredictedEquivalent } from "../../../src/lib/terminology/equivalents"
import {
  conceptMatchFromRow,
  loadProjectTermMatching,
  loadVisibleSourceTargets,
  loadVisibleSourceTexts,
  type VisiblePair,
} from "./concept-occurrences"
import { applyRenderingLaneScope, renderingLaneScope } from "./rendering-lane-scope"

/** Stop a violations response from growing without a bound. */
const MAX_VIOLATIONS = 8_000

interface ConceptScanRow {
  concept_id: string
  source_term: string
  renderings: unknown
  case_sensitive: number
  match_options: unknown
  status: string
}

interface ScannedConcept {
  id: string
  sourceTerm: string
  concept: ConceptMatchInput
  matcher: RegExp | null
}

export async function queryTerminologyViolations(
  db: AquillaDb,
  projectId: string,
  lane = "",
): Promise<TerminologyViolationsPage> {
  const [concepts, termMatching, loaded] = await Promise.all([
    loadConcepts(db, projectId, "active"),
    loadProjectTermMatching(db, projectId),
    loadVisibleSourceTargets(db, projectId, lane),
  ])
  const scope = await renderingLaneScope(db, projectId, lane)
  const scanned = concepts
    .map((row) => {
      const match = conceptMatchFromRow(row)
      return toScanned(
        { ...row, renderings: applyRenderingLaneScope(match.renderings, scope) },
        termMatching,
      )
    })
    .filter((row) => row.matcher)
  const violations: TerminologyViolationRow[] = []
  let truncated = false
  for (const pair of loaded.pairs) {
    for (const concept of scanned) {
      if (!pairHits(concept.matcher, pair.original)) continue
      for (const kind of violationKinds(concept.concept, pair.translated)) {
        if (violations.length >= MAX_VIOLATIONS) {
          truncated = true
          break
        }
        violations.push(toViolation(concept, pair, kind))
      }
      if (truncated) break
    }
    if (truncated) break
  }
  return { violations, scanComplete: loaded.scanComplete, truncated }
}

export async function queryTerminologyCandidates(
  db: AquillaDb,
  projectId: string,
): Promise<TerminologyCandidatesPage> {
  const [concepts, termMatching, loaded] = await Promise.all([
    loadConcepts(db, projectId),
    loadProjectTermMatching(db, projectId),
    loadVisibleSourceTexts(db, projectId),
  ])
  const managed: Concept[] = concepts.map((row) => {
    const concept = conceptMatchFromRow(row)
    return {
      id: row.concept_id,
      sourceTerm: row.source_term,
      renderings: concept.renderings,
      status: row.status === "draft" || row.status === "deprecated" ? row.status : "active",
      createdAt: "",
      ...(concept.caseSensitive ? { caseSensitive: true } : {}),
      ...(concept.match ? { match: concept.match } : {}),
    }
  })
  const candidates: TerminologyCandidateRow[] = extractCandidates(loaded.texts, {
    managed,
    termMatching,
  }).map((candidate) => ({ term: candidate.term, isManaged: candidate.isManaged }))
  return { candidates, scanComplete: loaded.scanComplete }
}

export async function queryConceptSuggestions(
  db: AquillaDb,
  projectId: string,
  conceptId: string,
  lane = "",
): Promise<{ suggestions: PredictedEquivalent[] } | null> {
  const concept = await loadOneConcept(db, projectId, conceptId)
  if (!concept) return null
  const loaded = await loadVisibleSourceTargets(db, projectId, lane)
  const suggestions = predictEquivalents(
    loaded.pairs.map((pair) => ({ source: pair.original, target: pair.translated })),
    concept.sourceTerm,
  )
  return { suggestions }
}

function toScanned(row: ConceptScanRow, termMatching: TermMatchingSettings | undefined): ScannedConcept {
  const concept = conceptMatchFromRow(row)
  const caseSensitive = concept.caseSensitive === true
  return {
    id: row.concept_id,
    sourceTerm: row.source_term,
    concept,
    matcher: buildConceptRegex(concept, termMatching, caseSensitive ? "u" : "iu"),
  }
}

function pairHits(matcher: RegExp | null, haystack: string): boolean {
  if (!matcher || !haystack) return false
  matcher.lastIndex = 0
  return matcher.test(haystack)
}

/**
 * Same split the rule compiler uses: a forbidden rendering in the target is
 * its own violation, and a missing approved rendering is another. A concept
 * with no approved rendering compiles to no "missing" rule.
 */
function violationKinds(
  concept: ConceptMatchInput,
  translated: string,
): TerminologyViolationKind[] {
  const renderings = concept.renderings ?? []
  const approved = renderings.filter((rendering) => rendering.status === "preferred" || rendering.status === "admitted")
  const forbidden = renderings.filter((rendering) => rendering.status === "forbidden")
  const kinds: TerminologyViolationKind[] = []
  if (forbidden.some((rendering) => matchesTerm(translated, rendering.rendering))) {
    kinds.push("forbidden-present")
  }
  if (approved.length > 0 && !approved.some((rendering) => matchesTerm(translated, rendering.rendering))) {
    kinds.push("missing-approved")
  }
  return kinds
}

function toViolation(
  concept: ScannedConcept,
  pair: VisiblePair,
  kind: TerminologyViolationKind,
): TerminologyViolationRow {
  return {
    conceptId: concept.id,
    sourceTerm: concept.sourceTerm,
    cellId: pair.cellId,
    fileId: pair.fileId,
    original: pair.original,
    translated: pair.translated,
    context: pair.context,
    kind,
  }
}

async function loadConcepts(
  db: AquillaDb,
  projectId: string,
  status?: "active",
): Promise<ConceptScanRow[]> {
  const statusSql = status ? " AND status = ?" : ""
  const result = await db
    .prepare(
      `SELECT concept_id, source_term, renderings, case_sensitive, match_options, status
       FROM concepts
       WHERE project_id = ? AND deleted_at IS NULL${statusSql}`,
    )
    .bind(...(status ? [projectId, status] : [projectId]))
    .all<ConceptScanRow>()
  return result.results
}

async function loadOneConcept(
  db: AquillaDb,
  projectId: string,
  conceptId: string,
): Promise<ConceptMatchInput | null> {
  const row = await db
    .prepare(
      `SELECT source_term, renderings, case_sensitive, match_options
       FROM concepts
       WHERE project_id = ? AND concept_id = ? AND deleted_at IS NULL`,
    )
    .bind(projectId, conceptId)
    .first<{
      source_term: string
      renderings: unknown
      case_sensitive: number
      match_options: unknown
    }>()
  if (!row) return null
  return conceptMatchFromRow(row)
}
