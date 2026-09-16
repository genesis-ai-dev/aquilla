// Server-side artifact parsing for the Agent API import workflow (AQU-533 §5:
// preview_import / prepare_import).
//
//   POST /api/v1/external/projects/:projectId/artifacts/:artifactId/parse
//     Body (JSON, every field optional):
//       fileType?          — override format detection ("usfm", "csv", …)
//       fileName?          — name for the created file (default: artifact name)
//       stage?             — false/absent = PREVIEW only; true = parse AND stage
//       sourceLanguage?    — forwarded onto the PlanImport command
//       targetLanguage?    — forwarded onto the PlanImport command
//       excludeFrontMatter? — USFM only: drop book-name/title/TOC/intro front
//                            matter; defaults to the project's
//                            importExcludeFrontMatter setting (AQU-1283)
//       resultIndex?       — which parsed file to use when the parse yields
//                            several (multi-book USFM); required to stage those
//       changesetId?       — client-supplied UUIDv7 for idempotent staging
//       autonomyMode?      — "ask" to downgrade an act credential (never upgrades)
//
//     Preview → { fileName, fileType, totalCells, sampleCells, warnings, results }
//     Stage   → the standard prepare envelope { changeset, summary, digest,
//               approvalUrl } (via handlePrepare — the SAME validation, role,
//               autonomy, and artifact checks as REST PlanImport) plus a `parse`
//               block echoing what was parsed.
//
// The parse itself lives in import-parse-core.ts (AQU-1294): this module is the
// ROUTE — auth, body validation, preview shaping, and the hand-off to
// handlePrepare. The ProjectSetup composite command calls the same core, so a
// plan's imports are parsed exactly as a preview parses them.
//
// Role floor: CONTRIBUTOR to parse (same as artifact upload — preview is a step
// of the import write workflow, not a plain read). Staging additionally hits
// handlePrepare's PlanImport floor (PROJECT_LEAD — the same floor the compiled
// file.create/source.cell.create events hit at the /events perimeter).

import { errorResponse } from './errors'
import { authArtifact } from './artifacts-route'
import { handlePrepare } from './prepare'
import { parseArtifactToCells } from './import-parse-core'
import { PLAN_IMPORT_MAX_CELLS, type PlanImportCommand } from './commands'
import { ROLE } from '../events/role-policy'
import type { ExternalEnv } from './types'

// Re-exported for the existing importers (discovery-route, mcp-handlers, the
// parse tests) that read the format tables through this module.
export {
  BINARY_PARSE_FILE_TYPES,
  CLIENT_ONLY_FORMATS,
  SERVER_PARSEABLE_FILE_TYPES,
  parseArtifactToCells,
  stringsToPlanImportCells,
  type ExcludeFrontMatterEcho,
  type ParseWarning,
  type ParsedArtifact,
  type ServerParseFileType,
  type UsfmNoteRecord,
} from './import-parse-core'

interface ParseRequestBody {
  fileType?: string
  fileName?: string
  stage?: boolean
  sourceLanguage?: string
  targetLanguage?: string
  excludeFrontMatter?: boolean
  resultIndex?: number
  changesetId?: string
  autonomyMode?: string
}

/** Hand-validate the optional JSON body (no zod — matches commands.ts). */
function readBody(raw: unknown): { ok: true; body: ParseRequestBody } | { ok: false; message: string } {
  if (raw === null || raw === undefined) return { ok: true, body: {} }
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, message: 'body must be a JSON object' }
  const b = raw as Record<string, unknown>
  for (const k of ['fileType', 'fileName', 'sourceLanguage', 'targetLanguage', 'changesetId', 'autonomyMode'] as const) {
    if (b[k] !== undefined && typeof b[k] !== 'string') return { ok: false, message: `${k} must be a string when present` }
  }
  for (const k of ['stage', 'excludeFrontMatter'] as const) {
    if (b[k] !== undefined && typeof b[k] !== 'boolean') return { ok: false, message: `${k} must be a boolean when present` }
  }
  if (b.resultIndex !== undefined && (typeof b.resultIndex !== 'number' || !Number.isInteger(b.resultIndex) || b.resultIndex < 0)) {
    return { ok: false, message: 'resultIndex must be a non-negative integer when present' }
  }
  return { ok: true, body: b as ParseRequestBody }
}

/** How many mapped cells a preview echoes back verbatim. */
export const PREVIEW_SAMPLE_CELLS = 10

export async function handleParseArtifact(
  request: Request,
  env: ExternalEnv,
  projectId: string,
  artifactId: string,
): Promise<Response> {
  if (!env.SNAPSHOTS) return errorResponse('job_failed', 'SNAPSHOTS bucket not configured')
  const authed = await authArtifact(request, env, projectId, ROLE.CONTRIBUTOR)
  if (!authed.ok) return authed.response

  let rawBody: unknown = null
  const bodyText = await request.text()
  if (bodyText.trim() !== '') {
    try {
      rawBody = JSON.parse(bodyText)
    } catch {
      return errorResponse('validation_failed', 'invalid JSON body')
    }
  }
  const parsedBody = readBody(rawBody)
  if (!parsedBody.ok) return errorResponse('validation_failed', parsedBody.message)
  const body = parsedBody.body

  const outcome = await parseArtifactToCells(env, projectId, artifactId, {
    ...(body.fileType !== undefined ? { fileType: body.fileType } : {}),
    ...(body.resultIndex !== undefined ? { resultIndex: body.resultIndex } : {}),
    ...(body.excludeFrontMatter !== undefined ? { excludeFrontMatter: body.excludeFrontMatter } : {}),
    // A preview may summarize a multi-book parse; staging must name the book.
    requireSingleResult: body.stage === true,
  })
  if (!outcome.ok) return outcome.response
  const { fileType, detectedFormat, cells, warnings, results, excludeFrontMatter, chosenName } = outcome.parsed
  const fileName = body.fileName ?? chosenName

  if (body.stage !== true) {
    return Response.json({
      fileName,
      fileType,
      ...(detectedFormat ? { detectedFormat } : {}),
      totalCells: cells.length,
      sampleCells: cells.slice(0, PREVIEW_SAMPLE_CELLS),
      warnings,
      excludeFrontMatter,
      results,
      limits: { planImportMaxCells: PLAN_IMPORT_MAX_CELLS },
      nextStep:
        'to stage this import as a changeset, POST the same route again with { "stage": true } ' +
        '(the response carries { changeset, digest, approvalUrl } for the normal confirm/commit flow)',
    })
  }

  // Stage: delegate to handlePrepare via a synthetic in-process request (the
  // same pattern the MCP adapter uses) so the PlanImport role floor, autonomy
  // ceiling, artifact link/fidelity checks, lane rules, cell cap, and the
  // prepare-time id ledger all come from ONE implementation.
  const command: PlanImportCommand = {
    kind: 'PlanImport',
    fileName,
    fileType,
    ...(body.sourceLanguage !== undefined ? { sourceLanguage: body.sourceLanguage } : {}),
    ...(body.targetLanguage !== undefined ? { targetLanguage: body.targetLanguage } : {}),
    artifactId,
    cells,
  }
  const prepareBody: Record<string, unknown> = { commands: [command] }
  if (body.changesetId !== undefined) prepareBody.id = body.changesetId
  if (body.autonomyMode !== undefined) prepareBody.autonomyMode = body.autonomyMode

  const headers: Record<string, string> = {
    Authorization: request.headers.get('Authorization') ?? '',
    'Content-Type': 'application/json',
  }
  // Preserve the channel stamp (commit provenance) for MCP-originated staging.
  const channel = request.headers.get('x-aquilla-channel')
  if (channel) headers['x-aquilla-channel'] = channel

  const prepared = await handlePrepare(
    new Request(`https://internal/api/v1/external/projects/${encodeURIComponent(projectId)}/changesets`, {
      method: 'POST',
      headers,
      body: JSON.stringify(prepareBody),
    }),
    env,
    projectId,
  )
  if (!prepared.ok) return prepared

  // Standard prepare envelope + a parse echo so the agent sees what was staged
  // without a second preview round-trip.
  const envelope = (await prepared.json()) as Record<string, unknown>
  return Response.json({
    ...envelope,
    parse: { fileName, fileType, totalCells: cells.length, warnings, excludeFrontMatter },
  })
}
