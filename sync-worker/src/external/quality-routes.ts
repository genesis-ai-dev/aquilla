// External quality-signal read surface (AQU-1231 — AI-console parity slice).
//
//   GET /api/v1/external/projects/:projectId/quality?fileId=&lane=&limit=&offset=
//   GET /api/v1/external/projects/:projectId/terms/consistency?fileId=&lane=&onlyDrift=1
//
// Why this exists: health scoring, coverage and term consistency all shipped
// in the product but had no API read, so an agent asked "which terms are
// rendered inconsistently across this book?" or "how healthy is this file?"
// had to reimplement the checks from raw cells — and any reimplementation
// drifts from what the user sees.
//
// PARITY IS THE SPEC. Nothing here recomputes a number:
//   - health   → delegates to the SAME internal route the health ring reads,
//                `health-rollup-route.ts` (mean confidence over translated
//                cells, multi-hop propagation).
//   - coverage → delegates per file to `progress-read-route.ts`, i.e. the
//                `file_section_progress` projection the in-app progress
//                surfaces read (including its `files`-counter fallback and
//                the project's configured validationCount). Whatever
//                counting rules that projection applies — AQU-1083's
//                headings/paratextual exclusion when it lands — this route
//                inherits automatically, by construction. There is no
//                denominator here to keep in step.
//   - terms    → runs the SPA's own scan, imported from
//                `src/lib/check/term-consistency-scan.ts` (the same function
//                the in-app "Check file" pass calls), over cells loaded from
//                the `cells` projection. Precedent for reaching into `src/`
//                from this worker: `external/import-parse.ts`.
//
// Delegation uses the short-lived internal sync-token minted by
// read-routes.ts's `mintInternalToken` — the same in-process pattern
// /files and /files/:fileId/cells already use, so auth/ETag/denominators are
// never re-derived here.
//
// Auth/scope/throttle are read-routes.ts's shared gate verbatim
// (`authenticateAndScope` + `checkReadRateLimit`): `aqk_` credential, scoped
// to this project AND org, live project role >= VIEWER. A credential scoped
// to another project gets `scope_denied` 403.

import { handleHealthRollupRequest } from "../events/health-rollup-route"
import { handleProgressReadRequest, type FileProgressResponse } from "../events/progress-read-route"
import { handleConceptsReadRequest } from "../events/concepts-read-route"
import { handleFilesReadRequest } from "../events/files-read-route"
import { externalError } from "./errors"
import { paginate, parsePageParams } from "./pagination"
import { mintInternalToken, type AuthedContext } from "./read-routes"
import { authenticateAndScope, checkReadRateLimit, type ExternalReadsEnv } from "./read-auth"
import {
  scanTermConsistency,
  type CheckableCell,
  type CheckableConcept,
  type TermConsistencyFinding,
} from "../../../src/lib/check/term-consistency-scan"

const QUALITY_RE = /^\/api\/v1\/external\/projects\/([^/]+)\/quality$/
const TERM_CONSISTENCY_RE = /^\/api\/v1\/external\/projects\/([^/]+)\/terms\/consistency$/

/** Files considered by one project-wide quality read. Matches
 *  health-rollup-route.ts's own MAX_FILES so the two agree on scope. */
const MAX_SCOPE_FILES = 200
/** Source cells scanned by one term-consistency read. Bounds the response and
 *  the regex sweep; a caller past this narrows with ?fileId=. */
const MAX_SCAN_CELLS = 5000

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Build a request against an internal route, carrying the minted token. */
async function internalRequest(
  env: ExternalReadsEnv,
  ctx: AuthedContext,
  projectId: string,
  fileId: string,
  path: string,
  search = "",
): Promise<Request> {
  const token = await mintInternalToken(env, ctx, projectId, fileId)
  const url = new URL(`https://internal${path}`)
  url.search = search
  return new Request(url.toString(), { headers: { Authorization: `Bearer ${token}` } })
}

function percent(part: number, whole: number): number {
  if (whole <= 0) return 0
  return Math.round((part / whole) * 100)
}

interface FileListEntry {
  fileId: string
  name: string
}

/** The files in scope, in the project's canonical listing order. A `fileId`
 *  filter narrows to that one file (404 if it is not in the project). */
async function resolveScopeFiles(
  env: ExternalReadsEnv,
  ctx: AuthedContext,
  projectId: string,
  fileIdFilter: string | null,
): Promise<{ ok: true; files: FileListEntry[] } | { ok: false; response: Response }> {
  const res = await handleFilesReadRequest(
    await internalRequest(env, ctx, projectId, "", `/api/v1/projects/${encodeURIComponent(projectId)}/files`),
    env,
  )
  if (!res) return { ok: false, response: externalError("not_found", "files route did not match", 404) }
  if (!res.ok) {
    return { ok: false, response: externalError("validation_failed", await res.text(), res.status) }
  }
  const body = (await res.json()) as { files: FileListEntry[] }
  const all = (body.files ?? []).map((f) => ({ fileId: f.fileId, name: f.name }))

  if (fileIdFilter === null) return { ok: true, files: all.slice(0, MAX_SCOPE_FILES) }
  const one = all.find((f) => f.fileId === fileIdFilter)
  if (!one) return { ok: false, response: externalError("not_found", "file not found in project", 404) }
  return { ok: true, files: [one] }
}

// ---------------------------------------------------------------------------
// GET /api/v1/external/projects/:projectId/quality
// ---------------------------------------------------------------------------

export interface ExternalFileCoverage {
  /** Source cells in the file (the denominator every percentage below uses). */
  totalCells: number
  /** Cells with a non-empty target in this lane. */
  filledCells: number
  /** Cells validated to the project's configured validationCount. */
  validatedCells: number
  /** Cells validated to each level 1..validationCount. */
  validationLevels: number[]
  audioCells: number
  audioValidatedCells: number
  filledPercent: number
  validatedPercent: number
}

export interface ExternalFileQuality {
  fileId: string
  name: string
  /** 0-100, mean confidence over translated cells (null when not translated). */
  health: number | null
  coverage: ExternalFileCoverage
  /** Endorsements a cell needs to count as validated in this project. */
  validationCount: number
  /** `file-counter-fallback` means the progress projection has no rows for
   *  this file yet and the `files` counters answered instead. */
  coverageSource: FileProgressResponse["source"]
}

function coverageOf(progress: FileProgressResponse): ExternalFileCoverage {
  const counts = progress.file
  return {
    totalCells: counts.totalCount,
    filledCells: counts.filledCount,
    validatedCells: counts.validatedCount,
    validationLevels: counts.validationLevels,
    audioCells: counts.audioCount,
    audioValidatedCells: counts.audioValidatedCount,
    filledPercent: percent(counts.filledCount, counts.totalCount),
    validatedPercent: percent(counts.validatedCount, counts.totalCount),
  }
}

async function handleQuality(
  request: Request,
  env: ExternalReadsEnv,
  projectId: string,
): Promise<Response> {
  const authed = await authenticateAndScope(request, env, projectId)
  if (!authed.ok) return authed.response
  const ctx = authed.ctx
  const db = env.AQUILLA_PG as AquillaDb
  const limited = await checkReadRateLimit(db, ctx.credential.credentialId)
  if (limited) return limited

  const url = new URL(request.url)
  const fileIdFilter = url.searchParams.get("fileId")
  const lane = url.searchParams.get("lane") ?? ""
  const { limit, offset } = parsePageParams(url)

  const scope = await resolveScopeFiles(env, ctx, projectId, fileIdFilter)
  if (!scope.ok) return scope.response

  // Health: one delegated call covers the whole scope (the rollup route
  // iterates the project's files itself, or one file with ?fileId=).
  const healthSearch = new URLSearchParams()
  if (fileIdFilter !== null) healthSearch.set("fileId", fileIdFilter)
  if (lane) healthSearch.set("lane", lane)
  const healthRes = await handleHealthRollupRequest(
    await internalRequest(
      env,
      ctx,
      projectId,
      fileIdFilter ?? "",
      `/api/v1/projects/${encodeURIComponent(projectId)}/health-rollup`,
      healthSearch.toString(),
    ),
    env,
  )
  if (!healthRes) return externalError("not_found", "health rollup route did not match", 404)
  if (!healthRes.ok) {
    return externalError("job_failed", await healthRes.text(), healthRes.status)
  }
  const health = (await healthRes.json()) as {
    projectHealth: number
    fileHealth: Record<string, number>
    totalCells: number
  }

  // Coverage: the progress projection is per file, so one delegated call each.
  const laneSearch = lane ? `lane=${encodeURIComponent(lane)}` : ""
  const perFile: ExternalFileQuality[] = []
  for (const file of scope.files) {
    const progressRes = await handleProgressReadRequest(
      await internalRequest(
        env,
        ctx,
        projectId,
        file.fileId,
        `/api/v1/projects/${encodeURIComponent(projectId)}/files/${encodeURIComponent(file.fileId)}/progress`,
        laneSearch,
      ),
      env,
    )
    // A file with no progress row and no `files` counters (503 "backfill
    // pending") is reported with zeroed coverage rather than failing the whole
    // read — one un-backfilled file must not hide the rest of the project.
    if (!progressRes || !progressRes.ok) {
      perFile.push({
        fileId: file.fileId,
        name: file.name,
        health: health.fileHealth[file.fileId] ?? null,
        coverage: {
          totalCells: 0,
          filledCells: 0,
          validatedCells: 0,
          validationLevels: [],
          audioCells: 0,
          audioValidatedCells: 0,
          filledPercent: 0,
          validatedPercent: 0,
        },
        validationCount: 0,
        coverageSource: undefined,
      })
      continue
    }
    const progress = (await progressRes.json()) as FileProgressResponse
    perFile.push({
      fileId: file.fileId,
      name: file.name,
      health: health.fileHealth[file.fileId] ?? null,
      coverage: coverageOf(progress),
      validationCount: progress.validationCount,
      coverageSource: progress.source,
    })
  }

  const totals = perFile.reduce(
    (acc, f) => ({
      totalCells: acc.totalCells + f.coverage.totalCells,
      filledCells: acc.filledCells + f.coverage.filledCells,
      validatedCells: acc.validatedCells + f.coverage.validatedCells,
    }),
    { totalCells: 0, filledCells: 0, validatedCells: 0 },
  )

  const page = paginate(perFile, offset, limit)
  return Response.json({
    projectId,
    lane,
    /** Same value the project health ring shows: cell-weighted mean over files. */
    projectHealth: health.projectHealth,
    /** Translated cells the health mean was taken over. */
    healthCellCount: health.totalCells,
    coverage: {
      ...totals,
      filledPercent: percent(totals.filledCells, totals.totalCells),
      validatedPercent: percent(totals.validatedCells, totals.totalCells),
    },
    fileCount: perFile.length,
    truncated: fileIdFilter === null && perFile.length >= MAX_SCOPE_FILES,
    ...page,
  })
}

// ---------------------------------------------------------------------------
// GET /api/v1/external/projects/:projectId/terms/consistency
// ---------------------------------------------------------------------------

interface ScanCellRow {
  cell_id: string
  canonical_ref: string | null
  value: string
  medium: string | null
  transcription: string | null
  target_value: string
}

/** Source cells joined to their target in `lane`, mapped to the shape the
 *  shared scan takes. `status` is left off: the scan skips an empty target
 *  either way. */
async function loadScanCells(
  db: AquillaDb,
  projectId: string,
  fileIds: readonly string[],
  lane: string,
): Promise<CheckableCell[]> {
  if (fileIds.length === 0) return []
  const placeholders = fileIds.map(() => "?").join(", ")
  const res = await db
    .prepare(
      "SELECT s.cell_id AS cell_id, s.canonical_ref AS canonical_ref, s.value AS value, " +
        "s.medium AS medium, s.transcription AS transcription, " +
        "COALESCE(t.value, '') AS target_value " +
        "FROM cells s " +
        "LEFT JOIN cells t " +
        "  ON t.project_id = s.project_id AND t.file_id = s.file_id " +
        "  AND t.cell_id = s.cell_id AND t.side = 'target' AND t.target_lang = ? " +
        `WHERE s.project_id = ? AND s.side = 'source' AND s.file_id IN (${placeholders}) ` +
        "ORDER BY s.file_id, s.cell_id " +
        "LIMIT ?",
    )
    .bind(lane, projectId, ...fileIds, MAX_SCAN_CELLS)
    .all<ScanCellRow>()

  return (res.results ?? []).map((row) => ({
    id: row.cell_id,
    cellLabel: row.canonical_ref ?? undefined,
    original: row.value,
    translated: row.target_value,
    medium: row.medium,
    transcription: row.transcription ?? undefined,
  }))
}

async function loadConcepts(
  env: ExternalReadsEnv,
  ctx: AuthedContext,
  projectId: string,
): Promise<{ ok: true; concepts: CheckableConcept[] } | { ok: false; response: Response }> {
  const res = await handleConceptsReadRequest(
    await internalRequest(env, ctx, projectId, "", `/api/v1/projects/${encodeURIComponent(projectId)}/concepts`),
    env,
  )
  if (!res) return { ok: false, response: externalError("not_found", "concepts route did not match", 404) }
  if (!res.ok) {
    return { ok: false, response: externalError("validation_failed", await res.text(), res.status) }
  }
  const body = (await res.json()) as {
    concepts: { conceptId: string; sourceTerm: string; status: string; renderings: { rendering: string; status: string }[] }[]
  }
  return {
    ok: true,
    concepts: (body.concepts ?? []).map((c) => ({
      id: c.conceptId,
      sourceTerm: c.sourceTerm,
      status: c.status,
      renderings: c.renderings,
    })),
  }
}

export interface ExternalTermConsistencyFinding extends TermConsistencyFinding {
  /** consistentCount / totalOccurrences, rounded — the "14 of 18 = 78%" the
   *  in-app check surface reports. */
  consistencyPercent: number
}

async function handleTermConsistency(
  request: Request,
  env: ExternalReadsEnv,
  projectId: string,
): Promise<Response> {
  const authed = await authenticateAndScope(request, env, projectId)
  if (!authed.ok) return authed.response
  const ctx = authed.ctx
  const db = env.AQUILLA_PG as AquillaDb
  const limited = await checkReadRateLimit(db, ctx.credential.credentialId)
  if (limited) return limited

  const url = new URL(request.url)
  const fileIdFilter = url.searchParams.get("fileId")
  const lane = url.searchParams.get("lane") ?? ""
  const onlyDrift = url.searchParams.get("onlyDrift") === "1"
  const { limit, offset } = parsePageParams(url)

  const scope = await resolveScopeFiles(env, ctx, projectId, fileIdFilter)
  if (!scope.ok) return scope.response

  const concepts = await loadConcepts(env, ctx, projectId)
  if (!concepts.ok) return concepts.response

  const cells = await loadScanCells(
    db,
    projectId,
    scope.files.map((f) => f.fileId),
    lane,
  )

  const findings: ExternalTermConsistencyFinding[] = scanTermConsistency(cells, concepts.concepts)
    .map((f) => ({ ...f, consistencyPercent: percent(f.consistentCount, f.totalOccurrences) }))
    .filter((f) => !onlyDrift || f.flaggedCells.length > 0)

  const flaggedCellCount = findings.reduce((n, f) => n + f.flaggedCells.length, 0)

  return Response.json({
    projectId,
    fileId: fileIdFilter,
    lane,
    /** Source cells the scan ran over (capped — see `truncated`). */
    scannedCells: cells.length,
    truncated: cells.length >= MAX_SCAN_CELLS,
    /** Active concepts with at least one approved rendering are scanned. */
    conceptCount: concepts.concepts.filter((c) => c.status === "active").length,
    /** Occurrences whose target used none of the concept's approved renderings. */
    flaggedCellCount,
    onlyDrift,
    ...paginate(findings, offset, limit),
  })
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export async function handleExternalQualityRequest(
  request: Request,
  env: ExternalReadsEnv,
): Promise<Response | null> {
  if (request.method !== "GET") return null
  const url = new URL(request.url)

  let match = url.pathname.match(QUALITY_RE)
  if (match) return handleQuality(request, env, decodeURIComponent(match[1]))

  match = url.pathname.match(TERM_CONSISTENCY_RE)
  if (match) return handleTermConsistency(request, env, decodeURIComponent(match[1]))

  return null
}
