import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"

export const ADOBE_GATE_SCHEMA_VERSION = 1 as const

export interface AdobeFixtureManifestEntry {
  id: string
  source: string
  candidate: string
  sourceSha256?: string
  candidateSha256?: string
  allowReflow?: boolean
  exportReport?: {
    translated: number
    missing: number
    rejected: number
    /**
     * Legacy manifests treated every unsupported diagnostic as blocking.
     * New producers must emit the split counts below instead.
     */
    unsupported?: number
    unsupportedLiteral?: number
    preservedUnsupported?: number
  }
}

export interface AdobeGateManifest {
  schemaVersion: 1
  engineVersion: 2
  sourceCommit: string
  preflightProfile: string
  gates: {
    browser: "passed" | "failed" | "not-run"
    migration: "passed" | "failed" | "not-run"
  }
  fixtures: AdobeFixtureManifestEntry[]
}

export interface AdobeDocumentMetrics {
  pageCount: number
  spreadCount: number
  masterSpreadCount: number
  layerCount: number
  storyCount: number
  footnoteCount: number
  endnoteCount: number
  noteCount: number
  tableCount: number
  hyperlinkCount: number
  textVariableCount: number
  crossReferenceCount: number
  pageItems: Array<{
    id: number
    type: string
    geometricBounds: string[]
    visibleBounds: string[]
    objectStyle: string
    layerId: number | null
    parentPageId: number | null
  }>
  tables: Array<{
    storyId: number
    index: number
    rowCount: number
    columnCount: number
    tableStyle: string
  }>
  paragraphAssignments: Array<{
    storyId: number
    index: number
    style: string
  }>
  characterAssignments: Array<{
    storyId: number
    index: number
    style: string
  }>
  links: Array<{
    id: number
    status: string
    type: string
  }>
  textVariables: Array<{
    name: string
    type: string
  }>
  crossReferences: Array<{
    name: string
    type: string
    format: string
  }>
  layers: Array<{ id: number; name: string }>
  masterSpreads: Array<{ id: number; name: string; pageCount: number }>
  oversetStoryIds: number[]
}

export interface AdobeDocumentObservation {
  opened: boolean
  preflightCompleted: boolean
  /** Zero means the named production profile completed without a violation. */
  preflightIssueCount: number | null
  preflightResults: unknown
  metrics?: AdobeDocumentMetrics
  error?: { code: string; message: string }
}

export interface AdobeRawFixtureResult {
  id: string
  source: AdobeDocumentObservation
  candidate: AdobeDocumentObservation
  reopened: AdobeDocumentObservation
  pdf: { created: boolean; byteLength: number }
  savedIdml: { created: boolean; byteLength: number }
  errors: Array<{ code: string; message: string }>
}

export interface AdobeRawReport {
  schemaVersion: 1
  executionMode: "indesign-server" | "desktop-manual"
  adobeVersion: string
  startedAt: string
  completedAt: string
  fixtures: AdobeRawFixtureResult[]
}

export type AdobeGateFailureCode =
  | "ADOBE_OPEN_FAILED"
  | "ADOBE_PREFLIGHT_FAILED"
  | "ADOBE_REOPEN_FAILED"
  | "ADOBE_PDF_EXPORT_FAILED"
  | "ADOBE_IDML_SAVE_FAILED"
  | "STRUCTURE_CHANGED"
  | "ANCHOR_LOSS"
  | "SILENT_SKIP"
  | "BROWSER_GATE_FAILED"
  | "MIGRATION_GATE_FAILED"

export interface AdobeGateFinding {
  fixtureId?: string
  code: AdobeGateFailureCode | "REFLOW_OR_OVERSET" | "PRESERVED_UNSUPPORTED"
  severity: "error" | "warning"
  detail: string
}

export interface AdobeGateReport {
  schemaVersion: 1
  engineVersion: 2
  sourceCommit: string
  adobeVersion: string
  automatedAdobe: boolean
  generatedAt: string
  status: "passed" | "failed"
  fixtureCount: number
  passedFixtureCount: number
  silentSkips: number
  unsupportedLiteral: number
  preservedUnsupported: number
  anchorLossCases: number
  mappingFailures: number
  findings: AdobeGateFinding[]
  durationMs: number
}

const STRUCTURAL_KEYS: Array<keyof AdobeDocumentMetrics> = [
  "pageCount",
  "spreadCount",
  "masterSpreadCount",
  "layerCount",
  "storyCount",
  "footnoteCount",
  "endnoteCount",
  "noteCount",
  "tableCount",
  "hyperlinkCount",
  "textVariableCount",
  "crossReferenceCount",
  "pageItems",
  "tables",
  "paragraphAssignments",
  "characterAssignments",
  "links",
  "textVariables",
  "crossReferences",
  "layers",
  "masterSpreads",
]

export function buildAdobeGateReport(
  manifest: AdobeGateManifest,
  raw: AdobeRawReport,
): AdobeGateReport {
  assertManifest(manifest)
  assertRawReport(raw)
  const started = Date.parse(raw.startedAt)
  const completed = Date.parse(raw.completedAt)
  const findings: AdobeGateFinding[] = []
  let silentSkips = 0
  let unsupportedLiteral = 0
  let preservedUnsupported = 0
  let anchorLossCases = 0
  let mappingFailures = 0
  let passedFixtureCount = 0

  if (manifest.gates.browser !== "passed") {
    findings.push({
      code: "BROWSER_GATE_FAILED",
      severity: "error",
      detail: `Browser gate is ${manifest.gates.browser}.`,
    })
  }
  if (manifest.gates.migration !== "passed") {
    findings.push({
      code: "MIGRATION_GATE_FAILED",
      severity: "error",
      detail: `Migration gate is ${manifest.gates.migration}.`,
    })
  }

  const rawIds = new Set<string>()
  const expectedIds = new Set(manifest.fixtures.map((fixture) => fixture.id))
  for (const fixture of raw.fixtures) {
    if (rawIds.has(fixture.id) || !expectedIds.has(fixture.id)) {
      findings.push(error(
        fixture.id || "unknown-fixture",
        "STRUCTURE_CHANGED",
        rawIds.has(fixture.id)
          ? "Adobe returned a duplicate fixture result."
          : "Adobe returned an unexpected fixture result.",
      ))
    }
    rawIds.add(fixture.id)
  }

  const rawById = new Map(raw.fixtures.map((fixture) => [fixture.id, fixture]))
  for (const expected of manifest.fixtures) {
    const result = rawById.get(expected.id)
    const fixtureFindings: AdobeGateFinding[] = []
    if (!result?.source.opened || !result.candidate.opened) {
      fixtureFindings.push(error(expected.id, "ADOBE_OPEN_FAILED", "Adobe did not open both source and candidate IDML files."))
    }
    if (
      !result?.source.preflightCompleted
      || !result.candidate.preflightCompleted
      || result.source.preflightIssueCount !== 0
      || result.candidate.preflightIssueCount !== 0
    ) {
      fixtureFindings.push(error(expected.id, "ADOBE_PREFLIGHT_FAILED", "Adobe preflight did not complete cleanly for both source and candidate."))
    }
    if (!result?.source.metrics || !result.candidate.metrics) {
      fixtureFindings.push(error(expected.id, "STRUCTURE_CHANGED", "Adobe omitted source or candidate structural metrics."))
    }
    if (!result?.savedIdml.created || result.savedIdml.byteLength <= 0) {
      fixtureFindings.push(error(expected.id, "ADOBE_IDML_SAVE_FAILED", "Adobe did not produce a non-empty save/reopen IDML artifact."))
    }
    if (
      !result?.reopened.opened
      || !result.reopened.preflightCompleted
      || result.reopened.preflightIssueCount !== 0
      || !result.reopened.metrics
    ) {
      fixtureFindings.push(error(expected.id, "ADOBE_REOPEN_FAILED", "Adobe did not reopen, measure, and cleanly preflight its saved IDML artifact."))
    }
    if (!result?.pdf.created || result.pdf.byteLength <= 0) {
      fixtureFindings.push(error(expected.id, "ADOBE_PDF_EXPORT_FAILED", "Adobe did not produce a non-empty PDF."))
    }

    if (result?.source.metrics && result.candidate.metrics) {
      const differences = structuralDifferences(result.source.metrics, result.candidate.metrics)
      if (differences.length > 0) {
        anchorLossCases += 1
        fixtureFindings.push(error(
          expected.id,
          "ANCHOR_LOSS",
          `Source/candidate structural mismatch: ${differences.join(", ")}.`,
        ))
      }
      appendReflowFinding(fixtureFindings, expected, result.source.metrics, result.candidate.metrics)
    }
    if (result?.candidate.metrics && result.reopened.metrics) {
      const differences = structuralDifferences(result.candidate.metrics, result.reopened.metrics)
      if (differences.length > 0) {
        fixtureFindings.push(error(
          expected.id,
          "STRUCTURE_CHANGED",
          `Candidate/save-reopen structural mismatch: ${differences.join(", ")}.`,
        ))
      }
      appendReflowFinding(fixtureFindings, expected, result.candidate.metrics, result.reopened.metrics)
    }

    const exportReport = expected.exportReport
    if (exportReport) {
      const missing = exportReport.missing + exportReport.rejected
      // Old manifests remain fail-closed: their undifferentiated count is
      // treated as unsupported literal content, never as safely preserved.
      const blockingUnsupported = exportReport.unsupportedLiteral
        ?? exportReport.unsupported
        ?? 0
      const preserved = exportReport.preservedUnsupported ?? 0
      mappingFailures += missing
      unsupportedLiteral += blockingUnsupported
      preservedUnsupported += preserved
      silentSkips += blockingUnsupported
      if (missing > 0) {
        fixtureFindings.push(error(expected.id, "STRUCTURE_CHANGED", `Exporter reported ${missing} mapping failure(s).`))
      }
      if (blockingUnsupported > 0) {
        fixtureFindings.push(error(
          expected.id,
          "SILENT_SKIP",
          `Exporter reported ${blockingUnsupported} unsupported literal construct(s).`,
        ))
      }
      if (preserved > 0) {
        fixtureFindings.push({
          fixtureId: expected.id,
          code: "PRESERVED_UNSUPPORTED",
          severity: "warning",
          detail:
            `Exporter preserved ${preserved} computed or unknown nonliteral construct(s) unchanged.`,
        })
      }
    }

    for (const rawError of result?.errors ?? []) {
      fixtureFindings.push(error(
        expected.id,
        rawError.code === "REPAIR_DIALOG" ? "ADOBE_OPEN_FAILED" : "STRUCTURE_CHANGED",
        rawError.message,
      ))
    }
    findings.push(...fixtureFindings)
    if (!fixtureFindings.some((finding) => finding.severity === "error")) {
      passedFixtureCount += 1
    }
  }

  const hasError = findings.some((finding) => finding.severity === "error")
  return {
    schemaVersion: ADOBE_GATE_SCHEMA_VERSION,
    engineVersion: 2,
    sourceCommit: manifest.sourceCommit,
    adobeVersion: raw.adobeVersion,
    automatedAdobe: raw.executionMode === "indesign-server",
    generatedAt: new Date().toISOString(),
    status: hasError ? "failed" : "passed",
    fixtureCount: manifest.fixtures.length,
    passedFixtureCount,
    silentSkips,
    unsupportedLiteral,
    preservedUnsupported,
    anchorLossCases,
    mappingFailures,
    findings,
    durationMs: Number.isFinite(started) && Number.isFinite(completed)
      ? Math.max(0, completed - started)
      : 0,
  }
}

export function structuralDifferences(
  before: AdobeDocumentMetrics,
  after: AdobeDocumentMetrics,
): string[] {
  return STRUCTURAL_KEYS.filter((key) => (
    stableJson(before[key]) !== stableJson(after[key])
  ))
}

export async function sha256File(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex")
}

export function assertManifest(value: AdobeGateManifest): void {
  if (value?.schemaVersion !== ADOBE_GATE_SCHEMA_VERSION) {
    throw new Error(`Unsupported Adobe gate manifest version ${String(value?.schemaVersion)}.`)
  }
  if (value.engineVersion !== 2) {
    throw new Error(`Unsupported IDML engine version ${String(value.engineVersion)}.`)
  }
  if (
    !/^[0-9a-f]{40}$/i.test(value.sourceCommit)
    || !value.preflightProfile
    || !Array.isArray(value.fixtures)
    || value.fixtures.length === 0
    || !value.gates
    || !["passed", "failed", "not-run"].includes(value.gates.browser)
    || !["passed", "failed", "not-run"].includes(value.gates.migration)
  ) {
    throw new Error("Adobe gate manifest is missing sourceCommit, preflightProfile, or fixtures.")
  }
  const ids = new Set<string>()
  for (const fixture of value.fixtures) {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(fixture.id)
      || !fixture.source
      || !fixture.candidate
      || ids.has(fixture.id)
      || (fixture.sourceSha256 !== undefined && !/^[0-9a-f]{64}$/i.test(fixture.sourceSha256))
      || (
        fixture.candidateSha256 !== undefined
        && !/^[0-9a-f]{64}$/i.test(fixture.candidateSha256)
      )
      || (fixture.exportReport && !validExportCounts(fixture.exportReport))
    ) {
      throw new Error(`Adobe gate manifest contains an invalid or duplicate fixture ${fixture.id}.`)
    }
    ids.add(fixture.id)
  }
}

function validExportCounts(
  report: NonNullable<AdobeFixtureManifestEntry["exportReport"]>,
): boolean {
  const baseCountsValid = [report.translated, report.missing, report.rejected]
    .every(nonnegativeSafeInteger)
  if (!baseCountsValid) return false
  const hasLegacy = report.unsupported !== undefined
  const hasSplit = (
    report.unsupportedLiteral !== undefined
    || report.preservedUnsupported !== undefined
  )
  if (hasLegacy === hasSplit) return false
  if (hasLegacy) return nonnegativeSafeInteger(report.unsupported)
  return (
    nonnegativeSafeInteger(report.unsupportedLiteral)
    && nonnegativeSafeInteger(report.preservedUnsupported)
  )
}

function nonnegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

export function assertRawReport(value: AdobeRawReport): void {
  if (
    value?.schemaVersion !== ADOBE_GATE_SCHEMA_VERSION
    || (value.executionMode !== "indesign-server" && value.executionMode !== "desktop-manual")
    || !Array.isArray(value.fixtures)
  ) {
    throw new Error("Adobe raw report has an unsupported schema.")
  }
}

function appendReflowFinding(
  findings: AdobeGateFinding[],
  fixture: AdobeFixtureManifestEntry,
  before: AdobeDocumentMetrics,
  after: AdobeDocumentMetrics,
): void {
  if (stableJson(before.oversetStoryIds) === stableJson(after.oversetStoryIds)) return
  findings.push({
    fixtureId: fixture.id,
    code: "REFLOW_OR_OVERSET",
    severity: "warning",
    detail: fixture.allowReflow
      ? "Overset/reflow changed as expected for translated text."
      : "Overset/reflow changed; review translation length and font coverage.",
  })
}

function error(
  fixtureId: string,
  code: AdobeGateFailureCode,
  detail: string,
): AdobeGateFinding {
  return { fixtureId, code, severity: "error", detail }
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortDeep(value))
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortDeep).sort((left, right) => (
      JSON.stringify(left).localeCompare(JSON.stringify(right))
    ))
  }
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortDeep(entry)]),
  )
}
