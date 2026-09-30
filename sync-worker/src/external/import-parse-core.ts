// Artifact → PlanImport cells, as a reusable core (AQU-1294 §2.1).
//
// Split out of import-parse.ts so the parse used by the REST/MCP preview+stage
// route (`handleParseArtifact`) and the parse used INSIDE a ProjectSetup plan
// are literally the same code. A composite plan re-parses its artifacts at
// commit — the artifact bytes are immutable, so a re-parse must reproduce the
// prepare-time cells exactly, and it only can if there is one parser path.
//
// The parsers are the SPA's own worker-safe text parse core
// (src/lib/parsers/parse-text-formats.ts — pure string/regex, no DOMParser)
// plus the DOCX parser (src/lib/parsers/docx.ts, which AQU-1237 moved off
// DOMParser/JSZip). Because the server calls the SAME parsers the in-app Import
// dialog calls, an agent import and a browser import of one file produce
// identical cells by construction.
//
// USFM is the one format where agent and browser imports deliberately differ
// (AQU-1283): the in-app importer is lossless (markers stay in `value`, the
// editor strips them at render), while the `agent:usfm` profile declares
// `fidelity: 'content-only'`. So USFM cells are run through usfmContentOnly —
// footnotes move to `metadata.usfmNotes`, character markers unwrap, `~` becomes
// a space — and the preview shows exactly what commits.

import { errorResponse } from './errors'
import { detectFormat, loadArtifact, type ArtifactRow } from './artifacts-route'
import { PLAN_IMPORT_MAX_CELLS, type PlanImportCell } from './commands'
import type { ExternalEnv } from './types'
import {
  parseTextFormat,
  TEXT_PARSE_FILE_TYPES,
  type TextParseFileType,
} from '../../../src/lib/parsers/parse-text-formats'
import { extractDocxStrings } from '../../../src/lib/parsers/docx'
import { usfmContentOnly } from '../../../src/lib/parsers/usfm-content-only'
import type { ParsedTextFileResult, TranslatableString } from '../../../src/lib/parsers/core-types'
import { loadProjectSettings } from '../../../db/shared/projects'
import type { UsfmNoteRecord } from '../lib/usfm-notes'

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

/** Footnote/endnote/crossref lifted out of a content-only USFM cell and kept
 *  in `metadata.usfmNotes` (AQU-1283). Defined in ../lib/usfm-notes.ts, which
 *  also owns the export-side reconstruction (AQU-1295); re-exported here
 *  because this module is where the records are written. */
export type { UsfmNoteRecord } from '../lib/usfm-notes'

/** Project a parsed string's text (and metadata) to content-only form. */
function contentOnlyText(
  s: TranslatableString,
): { original: string; translated: string; metadata: Record<string, unknown> | undefined } {
  const source = usfmContentOnly(s.original)
  // AQU-1295: `raw` is kept so export can put the note back byte-for-byte.
  // The parsed fields alone rebuild a note faithfully in content but not
  // necessarily character-for-character (a file's own `\fq`/`\fk` sub-markers
  // are flattened into `text`), and this is the only moment the original span
  // is in hand.
  const usfmNotes: UsfmNoteRecord[] = source.notes.map((n) => ({
    kind: n.noteKind,
    caller: n.caller,
    ref: n.ref,
    text: n.text,
    raw: n.raw,
  }))
  return {
    original: source.text,
    translated: usfmContentOnly(s.translated).text,
    metadata: usfmNotes.length > 0 ? { ...s.metadata, usfmNotes } : s.metadata,
  }
}

/** Map the parsers' TranslatableString onto PlanImportCell — the minimal,
 *  deterministic subset of the SPA's normalize path. Cell ids are deliberately
 *  NOT forwarded (parsers mint fresh UUIDs per run; omitting them keeps the
 *  staged command — and therefore the changeset digest — stable across
 *  identical re-parses, and prepare mints the definitive ids anyway).
 *
 *  `contentOnly` (USFM, AQU-1283) strips markup from every cell's text via
 *  usfmContentOnly, parking notes in `metadata.usfmNotes`. Any backslash that
 *  survives is counted into a `residual-markup` warning — it should be zero. */
export function stringsToPlanImportCells(
  strings: TranslatableString[],
  opts?: { contentOnly?: boolean },
): { cells: PlanImportCell[]; warnings: ParseWarning[] } {
  const warnings: ParseWarning[] = []
  const contentOnly = opts?.contentOnly === true
  let emptyCount = 0
  let droppedTimings = 0
  let cellsWithMarkup = 0

  const cells = strings.map((s): PlanImportCell => {
    const { original, translated, metadata } = contentOnly
      ? contentOnlyText(s)
      : { original: s.original, translated: s.translated, metadata: s.metadata }
    if (original.trim() === '') emptyCount++
    if (contentOnly && original.includes('\\')) cellsWithMarkup++
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
      content: original,
      ...(s.originalHtml !== undefined ? { contentHtml: s.originalHtml } : {}),
      ...(ref ? { canonicalRef: ref } : {}),
      ...(s.section !== undefined ? { section: s.section } : {}),
      type: s.type,
      ...(hasTiming
        ? { startMs: Math.round((s.start as number) * 1000), endMs: Math.round((s.end as number) * 1000) }
        : {}),
      ...(s.speaker !== undefined ? { speaker: s.speaker } : {}),
      ...(s.paragraphStart ? { paragraphStart: true } : {}),
      ...(metadata !== undefined ? { metadata } : {}),
      // Bilingual formats (csv/tsv, po, json with values) carry an existing
      // translation — land it in the DEFAULT lane ('' — no lane registration
      // needed), matching the browser's bilingual import.
      ...(translated.trim() !== ''
        ? {
            variants: [
              {
                laneId: '',
                content: translated,
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
  if (cellsWithMarkup > 0) {
    warnings.push({
      code: 'residual-markup',
      message: `${cellsWithMarkup} cell(s) still contain a USFM marker after content-only stripping`,
    })
  }
  return { cells, warnings }
}

/** Where the effective excludeFrontMatter value came from (echoed so an agent
 *  can tell a request override from the project default — AQU-1283). */
export interface ExcludeFrontMatterEcho {
  value: boolean
  source: 'request' | 'project-setting' | 'default'
}

/** Request override wins; else the project's `importExcludeFrontMatter`
 *  setting (the same toggle the in-app Import dialog honours); else false. */
async function resolveExcludeFrontMatter(
  db: AquillaDb,
  projectId: string,
  requested: boolean | undefined,
): Promise<ExcludeFrontMatterEcho> {
  if (requested !== undefined) return { value: requested, source: 'request' }
  const { settings } = await loadProjectSettings(db, projectId)
  const setting = settings.importExcludeFrontMatter
  if (typeof setting === 'boolean') return { value: setting, source: 'project-setting' }
  return { value: false, source: 'default' }
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

/** One parsed artifact, ready to become a preview body or a PlanImport. */
export interface ParsedArtifact {
  /** The artifact row's own name (the default file name for a single result). */
  artifactName: string
  fileType: ServerParseFileType
  detectedFormat: string | null
  /** The chosen result's name (multi-book USFM names each book). */
  chosenName: string
  cells: PlanImportCell[]
  warnings: ParseWarning[]
  results: { index: number; name: string; totalCells: number }[]
  excludeFrontMatter: ExcludeFrontMatterEcho
}

export interface ParseArtifactOptions {
  /** Caller override; aliases accepted. Absent = sniff the bytes. */
  fileType?: string
  /** Which parsed file to use when the parse yields several. */
  resultIndex?: number
  /** Request-level override of the project's importExcludeFrontMatter. */
  excludeFrontMatter?: boolean
  /** Refuse a multi-result parse that did not name a resultIndex. Set by every
   *  caller that is about to CREATE a file — a silent "first book only" is the
   *  failure mode this guards. */
  requireSingleResult?: boolean
}

/**
 * Read an artifact's bytes from R2 and parse them into PlanImport cells.
 *
 * The one parse path: `handleParseArtifact` (preview + stage) and the
 * ProjectSetup plan (prepare + the commit-time re-parse) both go through here,
 * so a plan's committed cells are the same cells the operator previewed.
 */
export async function parseArtifactToCells(
  env: ExternalEnv,
  projectId: string,
  artifactId: string,
  opts: ParseArtifactOptions = {},
): Promise<{ ok: true; parsed: ParsedArtifact } | { ok: false; response: Response }> {
  if (!env.SNAPSHOTS) {
    return { ok: false, response: errorResponse('job_failed', 'SNAPSHOTS bucket not configured') }
  }
  const db = env.AQUILLA_PG as AquillaDb
  const row: ArtifactRow | null = await loadArtifact(db, projectId, artifactId)
  if (!row) {
    return { ok: false, response: errorResponse('not_found', `artifact ${artifactId} not found`) }
  }
  if (row.kind !== 'source') {
    return {
      ok: false,
      response: errorResponse(
        'validation_failed',
        `artifact ${artifactId} is not a source artifact (kind: ${row.kind})`,
      ),
    }
  }

  // Full read (unlike /inspect's 64KB range) — the parsers need the whole text.
  // Bounded by the 25MB upload cap, which the worker already buffers on upload.
  const obj = await env.SNAPSHOTS.get(row.r2_key)
  if (!obj) {
    return { ok: false, response: errorResponse('not_found', 'artifact bytes missing from storage') }
  }
  const buffer = await obj.arrayBuffer()
  const bytes = new Uint8Array(buffer)
  // UTF-8 with BOM stripped — the text formats are text by definition. A binary
  // container decodes to mojibake here; it is only used for format sniffing,
  // and its parser reads the raw bytes instead.
  let text = new TextDecoder('utf-8').decode(bytes)
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)

  const resolved = resolveFileType(opts.fileType, text, bytes, row.name)
  if (!resolved.ok) return { ok: false, response: resolved.response }
  const { fileType, detectedFormat } = resolved
  const excludeFrontMatter = await resolveExcludeFrontMatter(db, projectId, opts.excludeFrontMatter)

  let results: ParsedTextFileResult[]
  try {
    results = BINARY_PARSE_FILE_TYPES.has(fileType)
      ? await parseBinaryFormat(fileType, buffer, row.name)
      : parseTextFormat({
          fileType: fileType as TextParseFileType,
          text,
          name: row.name,
          excludeFrontMatter: excludeFrontMatter.value,
        })
  } catch (err) {
    // Malformed archives, missing OOXML parts, and the zip-bomb guards all land
    // here — a named failure at preview, never a silent partial import. Log
    // server-side only; the raw error text must not reach the client.
    console.error(`[external-import-parse] parse failed for fileType "${fileType}":`, err)
    return {
      ok: false,
      response: errorResponse('validation_failed', `parse failed for fileType "${fileType}"`, {
        fileType,
        ...(detectedFormat ? { detectedFormat } : {}),
      }),
    }
  }
  if (results.length === 0 || results.every((r) => r.strings.length === 0)) {
    return {
      ok: false,
      response: errorResponse('validation_failed', `parsed 0 cells from artifact as "${fileType}"`, { fileType }),
    }
  }

  const resultsIndex = results.map((r, index) => ({ index, name: r.name, totalCells: r.strings.length }))

  // Multi-result parses (multi-book USFM splits per \id) create one file per
  // import — never a silent "first book only".
  if (opts.resultIndex !== undefined && opts.resultIndex >= results.length) {
    return {
      ok: false,
      response: errorResponse(
        'validation_failed',
        `resultIndex ${opts.resultIndex} out of range (parse produced ${results.length} file(s))`,
        { results: resultsIndex },
      ),
    }
  }
  if (opts.requireSingleResult && results.length > 1 && opts.resultIndex === undefined) {
    return {
      ok: false,
      response: errorResponse(
        'validation_failed',
        `this artifact parses into ${results.length} files (one per USFM book) — stage each separately by passing resultIndex`,
        { results: resultsIndex },
      ),
    }
  }

  const chosen = results[opts.resultIndex ?? 0]
  // The `agent:usfm` import profile is content-only (sfm aliases to usfm in
  // resolveFileType, so one check covers both spellings).
  const { cells, warnings } = stringsToPlanImportCells(chosen.strings, { contentOnly: fileType === 'usfm' })
  if (cells.length > PLAN_IMPORT_MAX_CELLS) {
    warnings.push({
      code: 'over-cell-cap',
      message: `${cells.length} cells exceeds the PlanImport cap of ${PLAN_IMPORT_MAX_CELLS} — staging will be rejected`,
    })
  }

  return {
    ok: true,
    parsed: {
      artifactName: row.name,
      fileType,
      detectedFormat,
      chosenName: results.length > 1 ? chosen.name : row.name,
      cells,
      warnings,
      results: resultsIndex,
      excludeFrontMatter,
    },
  }
}
