/**
 * Wire shapes for the project-wide terminology scans.
 *
 * Violations, suggested terms, and suggested renderings used to download every
 * verse into the browser. These payloads are the result of that scan, not the
 * verses themselves. No `@/` imports: the sync-worker bundles this module.
 */

import type { PredictedEquivalent } from "./equivalents"

export type TerminologyViolationKind = "missing-approved" | "forbidden-present"

export interface TerminologyViolationRow {
  conceptId: string
  sourceTerm: string
  cellId: string
  fileId: string
  original: string
  translated: string
  context: string
  kind: TerminologyViolationKind
}

export interface TerminologyViolationsPage {
  violations: TerminologyViolationRow[]
  /** False when the cell walk stopped at the scan cap. */
  scanComplete: boolean
  /** True when more infringements existed than this response carries. */
  truncated: boolean
}

export interface TerminologyCandidateRow {
  term: string
  isManaged: boolean
}

export interface TerminologyCandidatesPage {
  candidates: TerminologyCandidateRow[]
  scanComplete: boolean
}

export function parseTerminologyViolationsPage(body: unknown): TerminologyViolationsPage | null {
  if (!body || typeof body !== "object") return null
  const page = body as Record<string, unknown>
  if (
    !Array.isArray(page.violations) ||
    !page.violations.every(isViolation) ||
    typeof page.scanComplete !== "boolean" ||
    typeof page.truncated !== "boolean"
  ) {
    return null
  }
  return {
    violations: page.violations,
    scanComplete: page.scanComplete,
    truncated: page.truncated,
  }
}

export function parseTerminologyCandidatesPage(body: unknown): TerminologyCandidatesPage | null {
  if (!body || typeof body !== "object") return null
  const page = body as Record<string, unknown>
  if (
    !Array.isArray(page.candidates) ||
    !page.candidates.every(isCandidate) ||
    typeof page.scanComplete !== "boolean"
  ) {
    return null
  }
  return { candidates: page.candidates, scanComplete: page.scanComplete }
}

export function parsePredictedEquivalents(body: unknown): PredictedEquivalent[] | null {
  if (!body || typeof body !== "object") return null
  const page = body as Record<string, unknown>
  if (!Array.isArray(page.suggestions) || !page.suggestions.every(isPrediction)) return null
  return page.suggestions
}

function isViolation(value: unknown): value is TerminologyViolationRow {
  if (!value || typeof value !== "object") return false
  const row = value as Record<string, unknown>
  return (
    typeof row.conceptId === "string" &&
    typeof row.sourceTerm === "string" &&
    typeof row.cellId === "string" &&
    typeof row.fileId === "string" &&
    typeof row.original === "string" &&
    typeof row.translated === "string" &&
    typeof row.context === "string" &&
    (row.kind === "missing-approved" || row.kind === "forbidden-present")
  )
}

function isCandidate(value: unknown): value is TerminologyCandidateRow {
  if (!value || typeof value !== "object") return false
  const row = value as Record<string, unknown>
  return typeof row.term === "string" && typeof row.isManaged === "boolean"
}

function isPrediction(value: unknown): value is PredictedEquivalent {
  if (!value || typeof value !== "object") return false
  const row = value as Record<string, unknown>
  return (
    typeof row.target === "string" &&
    (row.source === "chi2" || row.source === "em" || row.source === "both") &&
    (row.confidence === "HIGH" || row.confidence === "AMBER" || row.confidence === "LOW") &&
    typeof row.confidenceScore === "number" &&
    Array.isArray(row.examples)
  )
}
