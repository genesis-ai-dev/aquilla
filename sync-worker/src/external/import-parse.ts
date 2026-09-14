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
//       excludeFrontMatter? — USFM only: drop book-name/title/TOC front matter
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
// The parsers are the SPA's own worker-safe text parse core
// (src/lib/parsers/parse-text-formats.ts — pure string/regex, no DOMParser),
// imported directly like shared/import-contract.ts, plus the DOCX parser
// (src/lib/parsers/docx.ts), which AQU-1237 moved off `DOMParser`/JSZip onto
// the platform-only `xml-lite` + `zip-lite` readers. Because the server calls
// the SAME `extractDocxStrings` the in-app Import dialog calls, an agent import
// and a browser import of one file produce identical cells by construction.
// The still-DOM-bound formats (pptx, html, xliff, tmx, usx, idml) CANNOT run
// here; they return a structured validation_failed naming the client-side
// alternatives instead of guessing.
//
// Role floor: CONTRIBUTOR to parse (same as artifact upload — preview is a step
// of the import write workflow, not a plain read). Staging additionally hits
// handlePrepare's PlanImport floor (PROJECT_LEAD — the same floor the compiled
// file.create/source.cell.create events hit at the /events perimeter).

import { errorResponse } from './errors'
import { authArtifact, loadArtifact, detectFormat, type ArtifactRow } from './artifacts-route'
import { handlePrepare } from './prepare'
import { PLAN_IMPORT_MAX_CELLS, type PlanImportCell, type PlanImportCommand } from './commands'
import { ROLE } from '../events/role-policy'
import type { ExternalEnv } from './types'
import {
  parseTextFormat,
  TEXT_PARSE_FILE_TYPES,
  type TextParseFileType,
} from '../../../src/lib/parsers/parse-text-formats'
import { extractDocxStrings } from '../../../src/lib/parsers/docx'
import type { ParsedTextFileResult, TranslatableString } from '../../../src/lib/parsers/core-types'

/** Formats parsed from BYTES rather than decoded text — zip containers whose
 *  parser reads members itself. Routed around the text-parse core below. */
export const BINARY_PARSE_FILE_TYPES: ReadonlySet<string> = new Set<string>(['docx'])

/** The union the parse route accepts. */
export type ServerParseFileType = TextParseFileType | 'docx'

/** Formats the server can parse (published by discovery + get_capabilities). */
export const SERVER_PARSEABLE_FILE_TYPES: readonly string[] = [
  ...TEXT_PARSE_FILE_TYPES,
  ...BINARY_PARSE_FILE_TYPES,
].sort()

/** Detected formats we recognize but cannot parse in the worker (DOM-bound
 *  parsers, binary containers, or multi-member packages). Kept as data so the
 *  error and the capability docs can never drift. */
export const CLIENT_ONLY_FORMATS: readonly string[] = [
  'pptx',
  'doc',
  'html',
  'xliff',
  'tmx',
  'usx',
  'idml',
  'paratext-project',
  'zip',
]

const CLIENT_ONLY_HINT =
  'this format is not yet server-parseable — import it through the in-app Import dialog ' +
  '(which runs the full parser set in the browser), or parse it yourself and stage raw ' +
  'PlanImport cells via POST .../changesets'

/** Caller-supplied fileType spellings → canonical parse types. */
const FILE_TYPE_ALIASES: Record<string, ServerParseFileType> = {
  sfm: 'usfm',
  markdown: 'md',
  plaintext: 'txt',
  text: 'txt',
  word: 'docx',
}

/** /inspect's detectedFormat values → canonical parse types. Formats absent
 *  here (po, properties, obs, sbv) are supported but not sniffable — callers
 *  name them explicitly via fileType. */
const DETECTED_TO_PARSE: Record<string, ServerParseFileType> = {
  docx: 'docx',
  usfm: 'usfm',
  json: 'json',
  csv: 'csv',
  tsv: 'tsv',
  vtt: 'vtt',
  srt: 'srt',
  markdown: 'md',
  plaintext: 'txt',
}

export interface ParseWarning {
  code: string
  message: string
}

/** Map the parsers' TranslatableString onto PlanImportCell — the minimal,
 *  deterministic subset of the SPA's normalize path. Cell ids are deliberately
 *  NOT forwarded (parsers mint fresh UUIDs per run; omitting them keeps the
 *  staged command — and therefore the changeset digest — stable across
 *  identical re-parses, and prepare mints the definitive ids anyway). */
export function stringsToPlanImportCells(
  strings: TranslatableString[],
): { cells: PlanImportCell[]; warnings: ParseWarning[] } {
  const warnings: ParseWarning[] = []
  let emptyCount = 0
  let droppedTimings = 0

  const cells = strings.map((s): PlanImportCell => {
    if (s.original.trim() === '') emptyCount++
    // Structural cells must not inherit a nearby verse ref as identity —
    // mirrors normalizeTranslatableStrings' heading/paratext rule.
    const structural = s.type === 'heading' || s.type === 'paratext'
    const ref = structural ? undefined : s.globalReferences?.[0]
    // Cue timings: PlanImport validation requires startMs/endMs together with
    // endMs > startMs — drop (and count) degenerate pairs instead of failing
    // the whole plan on one malformed subtitle cue.
    const hasTiming = s.start !== undefined && s.end !== undefined && s.end > s.start
    if (s.start !== undefined && s.end !== undefined && !hasTiming) droppedTimings++
    return {
      content: s.original,
      ...(s.originalHtml !== undefined ? { contentHtml: s.originalHtml } : {}),
      ...(ref ? { canonicalRef: ref } : {}),
      ...(s.section !== undefined ? { section: s.section } : {}),
      type: s.type,
      ...(hasTiming
        ? { startMs: Math.round((s.start as number) * 1000), endMs: Math.round((s.end as number) * 1000) }
        : {}),
      ...(s.speaker !== undefined ? { speaker: s.speaker } : {}),
      ...(s.paragraphStart ? { paragraphStart: true } : {}),
      ...(s.metadata !== undefined ? { metadata: s.metadata } : {}),
      // Bilingual formats (csv/tsv, po, json with values) carry an existing
      // translation — land it in the DEFAULT lane ('' — no lane registration
      // needed), matching the browser's bilingual import.
      ...(s.translated.trim() !== ''
        ? {
            variants: [
              {
                laneId: '',
                content: s.translated,
                ...(s.translatedHtml !== undefined ? { contentHtml: s.translatedHtml } : {}),
              },
            ],
          }
        : {}),
    }
  })

  if (emptyCount > 0) {
    warnings.push({ code: 'empty-source', message: `${emptyCount} cell(s) have no source text` })
  }
  if (droppedTimings > 0) {
    warnings.push({
      code: 'invalid-cue-timing',
      message: `${droppedTimings} cue(s) had end <= start — their timings were dropped (text kept)`,
    })
  }
  return { cells, warnings }
}

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

/** Resolve the parse fileType: explicit override first (aliases accepted),
 *  else the same sniffer /inspect uses, run over the full text. Returns a
 *  structured error naming supported types + the client alternative when the
 *  format cannot run server-side. */
function resolveFileType(
  explicit: string | undefined,
  text: string,
  bytes: Uint8Array,
  artifactName: string,
): { ok: true; fileType: ServerParseFileType; detectedFormat: string | null } | { ok: false; response: Response } {
  if (explicit !== undefined) {
    const normalized = explicit.trim().toLowerCase()
    const resolved =
      TEXT_PARSE_FILE_TYPES.has(normalized) || BINARY_PARSE_FILE_TYPES.has(normalized)
        ? (normalized as ServerParseFileType)
        : FILE_TYPE_ALIASES[normalized]
    if (resolved) return { ok: true, fileType: resolved, detectedFormat: null }
    return {
      ok: false,
      response: errorResponse(
        'validation_failed',
        CLIENT_ONLY_FORMATS.includes(normalized)
          ? `fileType "${explicit}" — ${CLIENT_ONLY_HINT}`
          : `unsupported fileType "${explicit}"`,
        { supportedFileTypes: SERVER_PARSEABLE_FILE_TYPES, clientOnlyFormats: CLIENT_ONLY_FORMATS },
      ),
    }
  }

  const { detectedFormat } = detectFormat(text.slice(0, 64 * 1024), bytes, artifactName)
  const mapped = DETECTED_TO_PARSE[detectedFormat]
  if (mapped) return { ok: true, fileType: mapped, detectedFormat }
  return {
    ok: false,
    response: errorResponse(
      'validation_failed',
      CLIENT_ONLY_FORMATS.includes(detectedFormat)
        ? `detected format "${detectedFormat}" — ${CLIENT_ONLY_HINT}`
        : `could not detect a server-parseable format (saw "${detectedFormat}") — pass fileType explicitly`,
      { detectedFormat, supportedFileTypes: SERVER_PARSEABLE_FILE_TYPES, clientOnlyFormats: CLIENT_ONLY_FORMATS },
    ),
  }
}

/**
 * Parse a byte-oriented (zip container) format into the same
 * `ParsedTextFileResult[]` shape the text core returns, so everything
 * downstream — cell mapping, cap checks, preview, staging — is shared.
 *
 * Each binary format delegates to the SPA parser the Import dialog uses; that
 * shared call IS the browser/server parity guarantee the acceptance criteria
 * asks for. Throws on malformed input (the caller turns it into a named
 * validation_failed).
 */
async function parseBinaryFormat(
  fileType: ServerParseFileType,
  buffer: ArrayBuffer,
  name: string,
): Promise<ParsedTextFileResult[]> {
  switch (fileType) {
    case 'docx':
      return [{ name, strings: await extractDocxStrings(buffer) }]
    default:
      // Unreachable while BINARY_PARSE_FILE_TYPES and this switch agree; the
      // drift test in external-import-parse.test.ts keeps them agreeing.
      throw new Error(`no binary parser registered for fileType "${fileType}"`)
  }
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

  const row: ArtifactRow | null = await loadArtifact(env.AQUILLA_PG as AquillaDb, projectId, artifactId)
  if (!row) return errorResponse('not_found', `artifact ${artifactId} not found`)
  if (row.kind !== 'source') {
    return errorResponse('validation_failed', `artifact ${artifactId} is not a source artifact (kind: ${row.kind})`)
  }

  // Full read (unlike /inspect's 64KB range) — the parsers need the whole text.
  // Bounded by the 25MB upload cap, which the worker already buffers on upload.
  const obj = await env.SNAPSHOTS.get(row.r2_key)
  if (!obj) return errorResponse('not_found', 'artifact bytes missing from storage')
  const buffer = await obj.arrayBuffer()
  const bytes = new Uint8Array(buffer)
  // UTF-8 with BOM stripped — the text formats are text by definition. A binary
  // container decodes to mojibake here; it is only used for format sniffing,
  // and its parser reads the raw bytes instead.
  let text = new TextDecoder('utf-8').decode(bytes)
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)

  const resolved = resolveFileType(body.fileType, text, bytes, row.name)
  if (!resolved.ok) return resolved.response
  const { fileType, detectedFormat } = resolved

  let results: ParsedTextFileResult[]
  try {
    results = BINARY_PARSE_FILE_TYPES.has(fileType)
      ? await parseBinaryFormat(fileType, buffer, row.name)
      : parseTextFormat({
          fileType: fileType as TextParseFileType,
          text,
          name: row.name,
          ...(body.excludeFrontMatter !== undefined ? { excludeFrontMatter: body.excludeFrontMatter } : {}),
        })
  } catch (err) {
    // Malformed archives, missing OOXML parts, and the zip-bomb guards all land
    // here — a named failure at preview, never a silent partial import. Log
    // server-side only; the raw error text must not reach the client.
    console.error(`[external-import-parse] parse failed for fileType "${fileType}":`, err)
    return errorResponse('validation_failed', `parse failed for fileType "${fileType}"`, {
      fileType,
      ...(detectedFormat ? { detectedFormat } : {}),
    })
  }
  if (results.length === 0 || results.every((r) => r.strings.length === 0)) {
    return errorResponse('validation_failed', `parsed 0 cells from artifact as "${fileType}"`, { fileType })
  }

  // Multi-result parses (multi-book USFM splits per \id) stage one file per
  // changeset — never a silent "first book only".
  if (body.resultIndex !== undefined && body.resultIndex >= results.length) {
    return errorResponse('validation_failed', `resultIndex ${body.resultIndex} out of range (parse produced ${results.length} file(s))`, {
      results: results.map((r, index) => ({ index, name: r.name, totalCells: r.strings.length })),
    })
  }
  if (body.stage === true && results.length > 1 && body.resultIndex === undefined) {
    return errorResponse(
      'validation_failed',
      `this artifact parses into ${results.length} files (one per USFM book) — stage each separately by passing resultIndex`,
      { results: results.map((r, index) => ({ index, name: r.name, totalCells: r.strings.length })) },
    )
  }

  const chosen = results[body.resultIndex ?? 0]
  const { cells, warnings } = stringsToPlanImportCells(chosen.strings)
  if (cells.length > PLAN_IMPORT_MAX_CELLS) {
    warnings.push({
      code: 'over-cell-cap',
      message: `${cells.length} cells exceeds the PlanImport cap of ${PLAN_IMPORT_MAX_CELLS} — staging will be rejected`,
    })
  }
  const fileName = body.fileName ?? (results.length > 1 ? chosen.name : row.name)

  if (body.stage !== true) {
    return Response.json({
      fileName,
      fileType,
      ...(detectedFormat ? { detectedFormat } : {}),
      totalCells: cells.length,
      sampleCells: cells.slice(0, PREVIEW_SAMPLE_CELLS),
      warnings,
      results: results.map((r, index) => ({ index, name: r.name, totalCells: r.strings.length })),
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
    parse: { fileName, fileType, totalCells: cells.length, warnings },
  })
}
