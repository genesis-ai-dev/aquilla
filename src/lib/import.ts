// Source import → AD-2 event log (server-first bulk upload).
//
// AD-2 makes the event log the source of truth. After parsing a file we emit:
//
//   1. file.create (genesis; project-scope)
//   2. one source.cell.create per parsed cell, chained via anchor_cell_id
//      (the previous cell's id, or null for the first)
//
// These are streamed straight to the sync worker's `POST /import` bulk endpoint
// in large chunks (see lib/sync/bulk-import.ts) rather than dripped through the
// outbox — a full eBible is ~31k cells, and the 100-per-5s outbox flush made
// that take minutes and fail silently. The cells projection lands as the server
// applies each chunk; the importer awaits completion and surfaces any error.
//
// `originals` (DOCX/PPTX blob storage in IDB) is dropped — AD-4 puts imported
// source blobs in R2; the future re-parse path fetches from R2.

import { v7 as uuidv7 } from "uuid"
import type { FileType, FileReference, TranslatableString, OrderedBy } from "./parsers/types"
import { detectFileType, isMediaFileType } from "./parsers/types"
import { buildAudioId, uploadCellAudio, deleteCellAudio } from "./audio/upload"
import { emitCellAudioAttach } from "./sync/events-emit"
import { detectSpeechSegments } from "./timeline/silence-split"
import { parseTextFormatOffMainThread } from "./parsers/parse-worker-client"
import { usfmSectionToStrings } from "./parsers/parse-text-formats"
import {
  assembleParatextProject,
  type ParatextBook,
  type ParatextProject,
  type ProjectEntry,
} from "./parsers/paratext-project"
import { buildBilingualPlan, type SourceVerse } from "./parsers/paratext-pairing"
import type { ParatextSettings } from "./parsers/paratext"
import { usxToUsfm, looksLikeUsx } from "./parsers/usx"
import { enqueueTargetCommits, bulkUploadMorphRows, type MorphRow, type TargetCommit } from "./sync/bulk-import"
import { extractDocxStrings } from "./parsers/docx"
import { extractPptxStrings } from "./parsers/pptx"
import { bulkUploadSource, type BulkImportCell } from "./sync/bulk-import"
import {
  fetchTranslationText,
  parseEBibleCorpus,
  type EBibleTranslation,
} from "./parsers/ebible"
import {
  fetchHelloaoComplete,
  parseHelloaoComplete,
  type HelloaoTranslation,
} from "./parsers/helloao"
import { parseXliff } from "./parsers/xliff"
import { parseTmx } from "./parsers/tmx"
import { parseMaculaTsv } from "./parsers/macula"
import { parseTnTsv } from "./parsers/translation-notes"
import { parseObsStories } from "./parsers/obs"

export type EBibleImportPhase = "download" | "parse" | "save"
export interface EBibleProgress {
  phase: EBibleImportPhase
  received?: number
  total?: number
  /** During the "save" phase: cells uploaded so far / total. */
  cellsEnqueued?: number
  cellsTotal?: number
}

// ---------------------------------------------------------------------------
// eBible → target column (AQU-191)
// ---------------------------------------------------------------------------

/**
 * Minimal cell descriptor passed into matchEBibleToSourceCells — callers
 * supply only the fields the matcher actually needs, drawn from CellData.
 */
export interface SourceCellRef {
  /** Logical cell id (shared between source + target rows). */
  cellId: string
  /** File this cell belongs to — needed so commits are scoped correctly. */
  fileId: string
  /** AD-2 chain head for the target row; undefined → no target commit yet. */
  targetEventId?: string
  /** AD-9 staleness pin — source cell's event_id. Used as parentId for a
   *  genesis target commit when targetEventId is absent. */
  sourceEventId?: string
  /** Current target text (may be empty). Non-empty → conflict. */
  translated: string
  /** Canonical reference, e.g. "GEN 1:1". Must match the vref vocabulary. */
  canonicalRef?: string | null
}

/** One cell's match result: the incoming eBible text paired with the source cell. */
export interface EBibleMatchedCell {
  cellId: string
  fileId: string
  /** Incoming eBible text for this ref. */
  incomingText: string
  /** Existing target content (empty string when cell has no target yet). */
  currentText: string
  /** True when `currentText` is non-empty — user must choose keep vs. replace. */
  hasConflict: boolean
  /** AD-2 parentId to use when emitting the commit. */
  parentId: string
  /** Canonical reference, e.g. "GEN 1:1" — for display. */
  ref: string
}

/** Orphan verse: present in the incoming eBible but matched no source cell. */
export interface EBibleOrphan {
  ref: string
  text: string
}

export interface EBibleMatchResult {
  matched: EBibleMatchedCell[]
  orphans: EBibleOrphan[]
  /** Cells the incoming corpus never had a verse for (the rare inverse orphan).
   *  Surfaced for completeness — typically 0 for whole-Bible imports. */
  unmatchedSourceCount: number
}

export type EBibleTargetPhase = "download" | "parse" | "match" | "save"
export interface EBibleTargetProgress {
  phase: EBibleTargetPhase
  received?: number
  total?: number
  cellsEnqueued?: number
  cellsTotal?: number
}

/**
 * Match parsed eBible verses to an existing set of source cells by canonical
 * reference. The canonical ref on each source cell is the `canonicalRef` field
 * (e.g. "GEN 1:1" from `TranslatableString.group`). Matching is exact — same
 * casing and spacing convention as the eBible vref list.
 *
 * Exported so tests can exercise matching in isolation.
 */
export function matchEBibleToSourceCells(
  verses: Array<{ ref: string; text: string }>,
  sourceCells: SourceCellRef[],
): EBibleMatchResult {
  // Build a map from canonicalRef → source cell. When multiple source cells
  // share the same ref (duplicate refs in the source file), the first one wins.
  const byRef = new Map<string, SourceCellRef>()
  for (const cell of sourceCells) {
    const ref = cell.canonicalRef
    if (ref && !byRef.has(ref)) {
      byRef.set(ref, cell)
    }
  }

  const matchedRefs = new Set<string>()
  const matched: EBibleMatchedCell[] = []
  const orphans: EBibleOrphan[] = []

  for (const verse of verses) {
    const cell = byRef.get(verse.ref)
    if (!cell) {
      orphans.push({ ref: verse.ref, text: verse.text })
      continue
    }
    matchedRefs.add(verse.ref)
    const currentText = cell.translated ?? ""
    // AD-2 parentId: chain off existing targetEventId if present, else off the
    // source cell's sourceEventId (genesis target commit). Fallback to empty
    // string only when neither is available (rare legacy cells with no event id).
    const parentId = cell.targetEventId ?? cell.sourceEventId ?? ""
    matched.push({
      cellId: cell.cellId,
      fileId: cell.fileId,
      incomingText: verse.text,
      currentText,
      hasConflict: currentText.trim().length > 0,
      parentId,
      ref: verse.ref,
    })
  }

  const unmatchedSourceCount = sourceCells.filter(
    (c) => c.canonicalRef && !matchedRefs.has(c.canonicalRef),
  ).length

  return { matched, orphans, unmatchedSourceCount }
}

/**
 * Download a specific eBible translation, parse it, and match its verses
 * against the provided source cells. Returns the match result so the caller
 * can show a review screen before committing.
 */
export async function prepareEBibleTargetImport(
  translation: EBibleTranslation,
  sourceCells: SourceCellRef[],
  onProgress?: (p: EBibleTargetProgress) => void,
  signal?: AbortSignal,
): Promise<EBibleMatchResult> {
  onProgress?.({ phase: "download", received: 0, total: 0 })

  const corpusText = await fetchTranslationText(
    translation.id,
    (received, total) => onProgress?.({ phase: "download", received, total }),
    signal,
  )

  onProgress?.({ phase: "parse" })
  const strings = parseEBibleCorpus(corpusText)
  if (strings.length === 0) {
    throw new Error(
      `"${translation.title}" is not available for download. ` +
      `The eBible corpus file exists but contains no text — ` +
      `this translation may be restricted due to copyright.`,
    )
  }

  const verses = strings.map((s) => ({
    ref: s.globalReferences?.[0] ?? s.context,
    text: s.original,
  }))

  onProgress?.({ phase: "match" })
  return matchEBibleToSourceCells(verses, sourceCells)
}

/**
 * Emit target.cell.commit events for the approved cells. `selectedCellIds` is
 * the set the user approved in the review screen — subset of matchResult.matched.
 * Cells with hasConflict=true and not in selectedCellIds are kept (skipped).
 *
 * parentId handling: each MatchedCell already carries the correct AD-2 parentId
 * (targetEventId ?? sourceEventId), so commits are always properly chained.
 */
export async function applyEBibleTargetImport(
  matchResult: EBibleMatchResult,
  selectedCellIds: Set<string>,
  ctx: Pick<ImportContext, "projectId" | "author" | "getToken" | "signal">,
  onProgress?: (p: EBibleTargetProgress) => void,
): Promise<{ committedCount: number; skippedCount: number }> {
  const toCommit = matchResult.matched.filter((m) => selectedCellIds.has(m.cellId))
  if (toCommit.length === 0) {
    return { committedCount: 0, skippedCount: matchResult.matched.length }
  }

  // Group by fileId — each file needs its own token.
  const byFile = new Map<string, EBibleMatchedCell[]>()
  for (const m of toCommit) {
    const arr = byFile.get(m.fileId) ?? []
    arr.push(m)
    byFile.set(m.fileId, arr)
  }

  onProgress?.({ phase: "save", cellsEnqueued: 0, cellsTotal: toCommit.length })
  let totalEnqueued = 0

  for (const [fileId, cells] of byFile) {
    const commits: TargetCommit[] = cells
      .filter((c) => c.parentId) // skip cells with no chain parent (edge case)
      .map((c) => ({
        id: uuidv7(),
        cellId: c.cellId,
        parentId: c.parentId,
        value: c.incomingText,
      }))

    await enqueueTargetCommits({
      projectId: ctx.projectId,
      fileId,
      author: ctx.author,
      commits,
      getToken: ctx.getToken,
      signal: ctx.signal,
      onProgress: (count) => {
        totalEnqueued += count
        onProgress?.({ phase: "save", cellsEnqueued: totalEnqueued, cellsTotal: toCommit.length })
      },
    })
  }

  const skippedCount = matchResult.matched.length - toCommit.length
  return { committedCount: toCommit.length, skippedCount }
}

export type MaculaImportPhase = "parse" | "save" | "morph"
export interface MaculaProgress {
  phase: MaculaImportPhase
  /** During the "save" phase: cells uploaded so far / total. */
  cellsEnqueued?: number
  cellsTotal?: number
  /** During the "morph" phase: morph rows uploaded so far / total. */
  morphEnqueued?: number
  morphTotal?: number
}

export type TnImportPhase = "parse" | "save"
export interface TnProgress {
  phase: TnImportPhase
  cellsEnqueued?: number
  cellsTotal?: number
  /** Number of rows skipped due to missing canonical_ref */
  skippedCount?: number
}

/**
 * Encode an ArrayBuffer to a base64 string. Used to capture binary source
 * blobs (DOCX, PPTX) as the round-trip side-car — the same mechanism USFM
 * uses for text. The server stores this in `file_source_blobs.raw_source`
 * (a TEXT column); the export route decodes it to reconstruct the original
 * file with translations substituted.
 */
export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ""
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

export interface ImportResult {
  name: string
  strings: TranslatableString[]
  /** Raw source bytes for round-trip-fidelity formats (USFM today). Stored
   *  side-car so export can reconstruct the original markup with current
   *  translations substituted. */
  rawSource?: string
  rawSourceFormat?: string
  /** USFM book code (\id), when known. Persisted on the file projection so the
   *  sidebar can group + order by canonical book. */
  bookCode?: string
  /** OT/NT grouping for the sidebar. */
  corpusMarker?: "OT" | "NT" | undefined
  /** Original filename (e.g. "01GENarONAV12.SFM") — preserved for export naming
   *  and hover-to-see-original when we rename the file to a localized book name. */
  originalName?: string
}

export interface ImportContext {
  projectId: string
  /** Authoring user id; events carry this as `author`. Per AD-2, system-emitted
   *  imports use the triggering admin's user id, not a synthetic 'system'. */
  author: string
  /** Optional language pair to stamp on the `file.create` payload. */
  sourceLanguage?: string
  targetLanguage?: string
  sourceTextDirection?: "ltr" | "rtl"
  targetTextDirection?: "ltr" | "rtl"
  /** Mints a sync-token scoped to (projectId, fileId) for the bulk upload. */
  getToken: (fileId: string) => Promise<string | null>
  /** Fired as cells upload — drives the dialog progress UI. */
  onCellEnqueued?: (uploaded: number, total: number) => void
  /** Aborts the in-flight upload (dialog close / cancel). */
  signal?: AbortSignal
  /**
   * AQU-287: Books (or files) the user chose to skip on collision.
   * Keys are USFM bookCodes (uppercase, e.g. "GEN") for Paratext imports, or
   * normalised file names (lowercase trimmed) for single-file imports.
   * `importParatextProject`, `importParatextAsTarget`, and `importFile` all
   * honour this set — matching items are added to `skipped` with reason
   * "skipped by user" rather than being uploaded.
   */
  skipKeys?: ReadonlySet<string>
}

function normalizeImportedDirection(value: string | undefined | null): "ltr" | "rtl" | undefined {
  const normalized = value?.trim().toLowerCase()
  return normalized === "ltr" || normalized === "rtl" ? normalized : undefined
}

export interface ImportFileResult {
  refs: FileReference[]
  /** Speaker→cellId pairs from every subtitle cue, sharing the same cellIds as
   *  the uploaded cells (single parse). Empty for non-subtitle formats. */
  speakerPairs: { cellId: string; speaker: string | undefined }[]
}

/**
 * Import a single user-supplied file. Each `ImportResult` (one per book for
 * USFM, one overall for single-blob formats) becomes one Aquilla File with
 * a chain of `source.cell.create` events.
 *
 * Returns `refs` (same as before) plus `speakerPairs` — the (cellId, speaker)
 * pairs produced by the *same* `buildBulkCellsWithSpeakers` call that minted
 * the uploaded cells, so the cellIds are guaranteed to match.
 */
export async function importFile(
  file: File,
  ctx: ImportContext,
): Promise<ImportFileResult> {
  const fileType = detectFileType(file.name)
  if (!fileType) {
    throw new Error(`Unsupported file type: ${file.name}`)
  }

  // Timeline-segment-model (Scope A): audio/video files have no text parser —
  // they import as a single media segment on a time-ordered file.
  if (isMediaFileType(fileType)) {
    const ref = await emitMediaFile(file, fileType, ctx)
    return { refs: [ref], speakerPairs: [] }
  }

  // AQU-287: single-file skip — key is normalized file name (lowercase trimmed).
  const fileNameKey = file.name.trim().toLowerCase()
  if (ctx.skipKeys?.has(fileNameKey)) {
    return { refs: [], speakerPairs: [] }
  }

  const results = await parseFile(file, fileType)
  const refs: FileReference[] = []
  const speakerPairs: { cellId: string; speaker: string | undefined }[] = []

  for (const result of results) {
    // AQU-287: per-result skip — key is normalized display name (for USFM parsed
    // results the name is the book display name; fall back to bookCode key too).
    const resultNameKey = result.name.trim().toLowerCase()
    const resultCodeKey = result.bookCode?.toUpperCase()
    if (
      ctx.skipKeys?.has(resultNameKey) ||
      (resultCodeKey && ctx.skipKeys?.has(resultCodeKey))
    ) {
      continue
    }
    const { ref, speakerPairs: pairs } = await emitParsedFile(result, fileType, ctx)
    refs.push(ref)
    speakerPairs.push(...pairs)
  }

  return { refs, speakerPairs }
}

export async function importEBible(
  translation: EBibleTranslation,
  ctx: ImportContext,
  onProgress?: (p: EBibleProgress) => void,
  signal?: AbortSignal,
): Promise<FileReference> {
  onProgress?.({ phase: "download", received: 0, total: 0 })

  const corpusText = await fetchTranslationText(
    translation.id,
    (received, total) => onProgress?.({ phase: "download", received, total }),
    signal,
  )

  onProgress?.({ phase: "parse" })
  const strings = parseEBibleCorpus(corpusText)
  if (strings.length === 0) {
    // Many eBible translations marked "downloadable" have empty corpus files —
    // the text is omitted for copyright reasons (only newlines are present).
    throw new Error(
      `"${translation.title}" is not available for download. ` +
      `The eBible corpus file exists but contains no text — ` +
      `this translation may be restricted due to copyright.`
    )
  }

  onProgress?.({ phase: "save", cellsEnqueued: 0, cellsTotal: strings.length })

  const fileName = `${translation.title} (${translation.id})`

  // eBible has no speaker tags — ignore speakerPairs.
  const { ref } = await emitParsedFile(
    { name: fileName, strings },
    "ebible",
    {
      ...ctx,
      sourceTextDirection: normalizeImportedDirection(translation.textDirection) ?? ctx.sourceTextDirection,
      signal: signal ?? ctx.signal,
      onCellEnqueued: (count, total) => {
        onProgress?.({ phase: "save", cellsEnqueued: count, cellsTotal: total })
        ctx.onCellEnqueued?.(count, total)
      },
    },
  )
  return ref
}

// ---------------------------------------------------------------------------
// Open Bible Stories (OBS) → source file
// ---------------------------------------------------------------------------

/** door43 (Gitea) repo coordinates for the English OBS source, mirroring the
 *  codex-editor extension's downloadObsRepository. */
const OBS_REPO = {
  baseUrl: "https://git.door43.org",
  owner: "unfoldingWord",
  repo: "en_obs",
  branch: "master",
  contentPath: "content",
} as const

/** One OBS story markdown file (name + raw content). */
export interface ObsStoryFile {
  name: string
  content: string
}

/**
 * List the story `.md` files in the OBS repo's content directory via the Gitea
 * contents API, then fetch each one's raw markdown. Mirrors the editor's
 * fetchRepositoryContents + fetchRawFileContent. Only the numbered story files
 * (`NN.md`) are kept, sorted by story number.
 */
async function downloadObsStoryFiles(
  onProgress?: (received: number, total: number) => void,
  signal?: AbortSignal,
): Promise<ObsStoryFile[]> {
  const apiUrl = `${OBS_REPO.baseUrl}/api/v1/repos/${OBS_REPO.owner}/${OBS_REPO.repo}/contents/${OBS_REPO.contentPath}?ref=${OBS_REPO.branch}`
  const listRes = await fetch(apiUrl, { signal })
  if (!listRes.ok) {
    throw new Error(`Failed to list OBS content: ${listRes.status} ${listRes.statusText}`)
  }
  const contents = (await listRes.json()) as Array<{ type: string; name: string; path: string }>
  const mdFiles = contents
    .filter((item) => item.type === "file" && /^\d{2}\.md$/.test(item.name))
    .sort((a, b) => parseInt(a.name, 10) - parseInt(b.name, 10))

  const out: ObsStoryFile[] = []
  for (let i = 0; i < mdFiles.length; i++) {
    if (signal?.aborted) throw new Error("Import cancelled")
    const item = mdFiles[i]
    const rawUrl = `${OBS_REPO.baseUrl}/${OBS_REPO.owner}/${OBS_REPO.repo}/raw/branch/${OBS_REPO.branch}/${item.path}`
    const fileRes = await fetch(rawUrl, { signal })
    if (!fileRes.ok) {
      // Skip an individual file rather than failing the whole import.
      console.warn(`[obs import] failed to fetch ${item.name}: ${fileRes.status}`)
      continue
    }
    out.push({ name: item.name, content: await fileRes.text() })
    onProgress?.(i + 1, mdFiles.length)
  }
  if (out.length === 0) throw new Error("No OBS story files could be downloaded")
  return out
}

/**
 * Import English Open Bible Stories as a single source file.
 *
 * Each OBS frame (image line + following paragraph) becomes ONE cell carrying
 * its reference image in `metadata.attachments` — same model as the
 * codex-editor extension. The cells flow through the SAME bulk path as
 * importEBible (`emitParsedFile` → `bulkUploadSource` → `source.cell.create`
 * with `metadata`), so the frame images persist to `cells.metadata`.
 *
 * IMPLEMENTED: the parse + emit path is complete and identical in shape to
 * importEBible. The door43 fetch is implemented (Gitea contents API +
 * raw-file fetch, mirroring the editor's downloadObsRepository). Callers may
 * also pass pre-fetched story files via `storyFiles` to skip the network entirely
 * (used by tests / offline imports). All 50 stories are concatenated into one
 * file named "Open Bible Stories"; frame refs are `OBS <story>:<frame>`.
 */
export async function importObs(
  ctx: ImportContext,
  opts?: {
    /** Pre-fetched OBS story markdown files. When provided, no network is used. */
    storyFiles?: ObsStoryFile[]
    fileName?: string
  },
  onProgress?: (p: EBibleProgress) => void,
  signal?: AbortSignal,
): Promise<FileReference> {
  onProgress?.({ phase: "download", received: 0, total: 0 })

  const storyFiles =
    opts?.storyFiles ??
    (await downloadObsStoryFiles(
      (received, total) => onProgress?.({ phase: "download", received, total }),
      signal ?? ctx.signal,
    ))

  onProgress?.({ phase: "parse" })

  // One flat cell list across all stories, in story/frame order.
  const strings: TranslatableString[] = []
  for (const story of storyFiles) {
    strings.push(...parseObsStories(story.content, story.name))
  }
  if (strings.length === 0) {
    throw new Error("Open Bible Stories downloaded but produced no frames — check the source.")
  }

  onProgress?.({ phase: "save", cellsEnqueued: 0, cellsTotal: strings.length })

  const fileName = opts?.fileName ?? "Open Bible Stories"

  const { ref } = await emitParsedFile(
    { name: fileName, strings },
    "obs",
    {
      ...ctx,
      signal: signal ?? ctx.signal,
      onCellEnqueued: (count, total) => {
        onProgress?.({ phase: "save", cellsEnqueued: count, cellsTotal: total })
        ctx.onCellEnqueued?.(count, total)
      },
    },
  )
  return ref
}

/**
 * Import a Hello AO (bible.helloao.org) translation as a source file.
 *
 * Always fetches the whole-translation bulk endpoint (`complete.json`) in a
 * single request — never per-chapter fan-out — and filters to `selectedBooks`
 * (USFM codes; null/empty = whole bible) client-side. Reuses EBibleProgress
 * since the phases are identical.
 */
export async function importHelloao(
  translation: HelloaoTranslation,
  selectedBooks: ReadonlySet<string> | null,
  ctx: ImportContext,
  onProgress?: (p: EBibleProgress) => void,
  signal?: AbortSignal,
): Promise<FileReference> {
  onProgress?.({ phase: "download", received: 0, total: 0 })

  const complete = await fetchHelloaoComplete(
    translation.id,
    (received, total) => onProgress?.({ phase: "download", received, total }),
    signal,
  )

  onProgress?.({ phase: "parse" })
  const strings = parseHelloaoComplete(complete, selectedBooks)
  if (strings.length === 0) {
    throw new Error(
      `"${translation.englishName || translation.name}" downloaded but produced no verses — ` +
      `check the book selection and try again.`
    )
  }

  onProgress?.({ phase: "save", cellsEnqueued: 0, cellsTotal: strings.length })

  const fileName = `${translation.englishName || translation.name} (${translation.id})`

  const { ref } = await emitParsedFile(
    { name: fileName, strings },
    "helloao",
    {
      ...ctx,
      sourceTextDirection: normalizeImportedDirection(translation.textDirection) ?? ctx.sourceTextDirection,
      signal: signal ?? ctx.signal,
      onCellEnqueued: (count, total) => {
        onProgress?.({ phase: "save", cellsEnqueued: count, cellsTotal: total })
        ctx.onCellEnqueued?.(count, total)
      },
    },
  )
  return ref
}

/**
 * Import a Macula TSV file (Hebrew or Greek) as a source file.
 *
 * Parses the TSV into verse cells + per-word morphology rows. The cells are
 * uploaded via the normal bulkUploadSource path (import-route.ts), and the
 * morph rows are uploaded separately to /import-morph. On success returns one
 * FileReference (one book per file, per the Macula format).
 *
 * The import carries per-file source_language: 'hbo' for OT books, 'grc' for NT.
 */
export async function importMacula(
  file: File,
  ctx: Pick<ImportContext, "projectId" | "author" | "getToken">,
  onProgress?: (p: MaculaProgress) => void,
): Promise<FileReference[]> {
  onProgress?.({ phase: "parse" })

  const text = await file.text()
  const { strings, morphRows, bookCode, sourceLanguage } = parseMaculaTsv(text)

  if (strings.length === 0) {
    throw new Error("Macula file parsed but no verses were found — check the file format.")
  }

  // Build bulk cells (no speaker pairs needed for Macula).
  const { cells } = buildBulkCellsWithSpeakers(strings)
  const fileId = uuidv7()

  // Derive a display name: bookCode is the USFM book code (e.g. "GEN").
  // Use a human-readable form when possible; fall back to the raw code.
  const displayName = bookCode

  onProgress?.({ phase: "save", cellsEnqueued: 0, cellsTotal: cells.length })

  await bulkUploadSource({
    projectId: ctx.projectId,
    fileId,
    file: {
      id: uuidv7(),
      name: displayName,
      fileType: "usfm",
      role: "source",
      kind: "usfm",
      importFormat: "macula-bible",
      parserVersion: "macula-tsv-v1",
      sourceLanguage,
      bookCode,
    },
    cells,
    getToken: ctx.getToken,
    onProgress: (count, total) => {
      onProgress?.({ phase: "save", cellsEnqueued: count, cellsTotal: total })
    },
  })

  // Build flat morph row list, keyed by cellId (parallel to strings/cells).
  // cells[i].cellId corresponds to strings[i] / morphRows[i].
  const allMorphRows: MorphRow[] = []
  for (let i = 0; i < cells.length; i++) {
    const cellId = cells[i].cellId
    const wordMorphs = morphRows[i] ?? []
    for (const w of wordMorphs) {
      const row: MorphRow = {
        cell_id: cellId,
        word_seq: w.word_seq,
        surface: w.surface,
      }
      if (w.lemma) row.lemma = w.lemma
      if (w.morph_code) row.morph_code = w.morph_code
      if (w.strongs_h) row.strongs_h = w.strongs_h
      if (w.strongs_g) row.strongs_g = w.strongs_g
      allMorphRows.push(row)
    }
  }

  // Upload morphology rows to /import-morph. If the server doesn't yet support
  // this endpoint (404), we surface a SWARM-TODO and continue — cells are already
  // uploaded so the source is usable in the editor.
  if (allMorphRows.length > 0) {
    onProgress?.({ phase: "morph", morphEnqueued: 0, morphTotal: allMorphRows.length })
    try {
      await bulkUploadMorphRows({
        projectId: ctx.projectId,
        fileId,
        rows: allMorphRows,
        getToken: ctx.getToken,
        onProgress: (count, total) => {
          onProgress?.({ phase: "morph", morphEnqueued: count, morphTotal: total })
        },
      })
    } catch (err) {
      // SWARM-TODO(server-morph): /import-morph endpoint not yet implemented in
      // sync-worker — morph rows are parsed client-side but not persisted to
      // cell_word_morph on the server. The source text (cells) IS uploaded and
      // usable in the editor. Morph server persistence requires adding
      // handleBulkMorphImportRequest to sync-worker/src/events/import-morph-route.ts
      // and registering it in sync-worker/src/events/route.ts.
      // For now, log the error rather than failing the whole import.
      console.warn("[importMacula] morph upload failed (server endpoint may not be deployed):", err)
    }
  }

  return [
    {
      id: fileId,
      name: displayName,
      type: "usfm",
      createdAt: new Date().toISOString(),
      cellCount: cells.length,
      corpusMarker: sourceLanguage === "hbo" ? "OT" : "NT",
    },
  ]
}

/**
 * Import a Translation Notes TSV file as a `translation-notes` file.
 *
 * Each TSV row (with a valid book/chapter/verse) becomes one cell whose
 * `canonicalRef` is set to "<book> <chapter>:<verse>". The TN sidebar in the
 * cell editor looks up cells by canonicalRef across all TN files in the project.
 *
 * Persistence choice: client-side parse + standard bulkUploadSource (same path
 * as every other text import). No server-side migration is needed because the
 * `canonical_ref` column is already present on the cells projection. The TN
 * sidebar reads cells from the server's existing cells-read route, filtered
 * client-side by `canonicalRef`. This avoids a new DB table or migration number.
 */
export async function importTranslationNotes(
  file: File,
  ctx: Pick<ImportContext, "projectId" | "author" | "getToken">,
  onProgress?: (p: TnProgress) => void,
): Promise<FileReference> {
  onProgress?.({ phase: "parse" })

  const text = await file.text()
  const { strings, skippedCount } = parseTnTsv(text)

  if (strings.length === 0) {
    throw new Error(
      "TN file parsed but no valid note rows were found — check that the first three columns are book, chapter, and verse."
        + (skippedCount > 0 ? ` (${skippedCount} rows skipped due to missing canonical reference)` : ""),
    )
  }

  const { cells } = buildBulkCellsWithSpeakers(strings)
  const fileId = uuidv7()

  onProgress?.({ phase: "save", cellsEnqueued: 0, cellsTotal: cells.length, skippedCount })

  await bulkUploadSource({
    projectId: ctx.projectId,
    fileId,
    file: {
      id: uuidv7(),
      name: file.name,
      fileType: "tsv",
      role: "source",
      kind: "translation-notes",
      importFormat: "tn-tsv",
      parserVersion: "tn-tsv-v1",
    },
    cells,
    getToken: ctx.getToken,
    onProgress: (count, total) => {
      onProgress?.({ phase: "save", cellsEnqueued: count, cellsTotal: total, skippedCount })
    },
  })

  return {
    id: fileId,
    name: file.name,
    type: "tsv",
    createdAt: new Date().toISOString(),
    cellCount: cells.length,
  }
}

/**
 * Map parsed `TranslatableString[]` to `BulkImportCell[]` + speaker pairs (one
 * per cell). Chaining cells via `anchorCellId` and threading timecodes when
 * present. The speaker pairs share the same `cellId` as their cell so callers
 * can pass them straight to `buildCastAdditions`. Exported for testing.
 */
export function buildBulkCellsWithSpeakers(strings: TranslatableString[]): {
  cells: BulkImportCell[]
  speakerPairs: { cellId: string; speaker: string | undefined }[]
} {
  const cells: BulkImportCell[] = []
  const speakerPairs: { cellId: string; speaker: string | undefined }[] = []
  let prevCellId: string | null = null
  let seq = 0
  for (const str of strings) {
    const cellId = str.id || uuidv7()
    cells.push({
      id: uuidv7(),
      cellId,
      anchorCellId: prevCellId,
      value: str.original,
      ...(str.originalHtml ? { valueHtml: str.originalHtml } : {}),
      ...(str.type !== undefined ? { type: str.type } : {}),
      ...(str.group ? { canonicalRef: str.group } : {}),
      ...(str.start !== undefined && str.end !== undefined ? { startMs: Math.round(str.start * 1000), endMs: Math.round(str.end * 1000) } : {}),
      // Timeline-segment-model: intrinsic order key (import order). For
      // time-ordered files it is the tiebreak / home for untimed rows; for
      // sequence-ordered files it IS the order. `medium` defaults to 'text'
      // (absent), so only an explicit media import needs to set it.
      sequenceIndex: seq,
      ...(str.medium ? { medium: str.medium } : {}),
      ...(str.paragraphStart ? { paragraphStart: true } : {}),
      // Extensible per-cell metadata (OBS frame attachments today). Threaded
      // into the bulk POST body verbatim → cells.metadata JSONB on the server.
      ...(str.metadata ? { metadata: str.metadata } : {}),
    })
    speakerPairs.push({ cellId, speaker: str.speaker })
    prevCellId = cellId
    seq += 1
  }
  return { cells, speakerPairs }
}

/**
 * Map parsed `TranslatableString[]` to `BulkImportCell[]`, chaining cells via
 * `anchorCellId` and threading timecodes when present. Exported so tests can
 * exercise the mapping in isolation.
 */
export function buildBulkCells(strings: TranslatableString[]): BulkImportCell[] {
  return buildBulkCellsWithSpeakers(strings).cells
}

export interface EmitParsedFileResult {
  ref: FileReference
  /** (cellId, speaker) pairs from the same `buildBulkCellsWithSpeakers` call
   *  that produced the uploaded cells — cellIds are guaranteed to match. */
  speakerPairs: { cellId: string; speaker: string | undefined }[]
}

/**
 * Build `file.create` + N chained `source.cell.create` and stream them to the
 * server's bulk-import endpoint. Returns a `FileReference` plus the
 * `speakerPairs` from the single `buildBulkCellsWithSpeakers` call, so callers
 * can build cast assignments keyed to the real uploaded cellIds. Throws (with a
 * human-readable message) if the upload fails.
 */
export async function emitParsedFile(
  result: ImportResult,
  fileType: FileType,
  ctx: ImportContext,
): Promise<EmitParsedFileResult> {
  const fileId = uuidv7()

  // Chain cells via anchorCellId: the first cell's anchor is null (genesis —
  // first in file); each subsequent cell anchors on the prior cell's id.
  // Use buildBulkCellsWithSpeakers so we capture speakerPairs from the SAME
  // call that mints the cellIds — avoids the double-parse cellId mismatch.
  const { cells, speakerPairs } = buildBulkCellsWithSpeakers(result.strings)

  // Timeline-segment-model: subtitle imports are time-true (their cues carry
  // timecodes and the timeline is the spine); every text/document format is
  // sequence-true. Absent ⇒ the client treats a file as 'sequence', so we only
  // need to mark the time-ordered case explicitly.
  const orderedBy: OrderedBy = orderedByForFileType(fileType)

  await bulkUploadSource({
    projectId: ctx.projectId,
    fileId,
    file: {
      id: uuidv7(),
      name: result.name,
      fileType,
      role: "source",
      kind: fileType,
      importFormat: fileType,
      parserVersion: "workspace-import-v1",
      sourceLanguage: ctx.sourceLanguage,
      targetLanguage: ctx.targetLanguage,
      sourceTextDirection: ctx.sourceTextDirection,
      targetTextDirection: ctx.targetTextDirection,
      orderedBy,
      ...(result.bookCode ? { bookCode: result.bookCode } : {}),
    },
    cells,
    rawSource: result.rawSource,
    rawSourceFormat: result.rawSourceFormat,
    getToken: ctx.getToken,
    onProgress: ctx.onCellEnqueued,
    signal: ctx.signal,
  })

  return {
    ref: {
      id: fileId,
      name: result.name,
      type: fileType,
      createdAt: new Date().toISOString(),
      cellCount: cells.length,
      orderedBy,
      ...(ctx.sourceLanguage ? { sourceLanguage: ctx.sourceLanguage } : {}),
      ...(ctx.targetLanguage ? { targetLanguage: ctx.targetLanguage } : {}),
      ...(ctx.sourceTextDirection ? { sourceTextDirection: ctx.sourceTextDirection } : {}),
      ...(ctx.targetTextDirection ? { targetTextDirection: ctx.targetTextDirection } : {}),
      ...(result.corpusMarker ? { corpusMarker: result.corpusMarker } : {}),
      ...(result.originalName ? { originalName: result.originalName } : {}),
    },
    speakerPairs,
  }
}

/** Subtitle + media formats are time-ordered (the timeline is the spine);
 *  every text/document format is sequence-ordered. */
export function orderedByForFileType(fileType: FileType): OrderedBy {
  return fileType === "vtt" || fileType === "srt" || isMediaFileType(fileType)
    ? "time"
    : "sequence"
}

export interface MediaSegmentSpec {
  cellId: string
  startMs?: number
  endMs?: number
  /** Playback window into the shared clip — the bytes are uploaded once, not N times. */
  trimStartMs?: number
  trimEndMs?: number
}

/**
 * Decode a media file and split it into per-line segment specs at detected
 * silences (Part B). Falls back to a single whole-file spec when decode fails
 * (e.g. a video container we can't decode here) or the split yields ≤1 region.
 * Never synthesizes timing — a fallback spec uses the real probed duration, or
 * is left untimed (editor flags it) if even that fails. Shared by the importer
 * (new file) and the media-lens attach flow (existing file).
 */
export async function computeMediaSegmentSpecs(
  file: File,
): Promise<{ durationMs: number | undefined; specs: MediaSegmentSpec[] }> {
  const decoded = await decodeAudioFile(file).catch(() => null)
  const durationMs = decoded?.durationMs ?? (await probeMediaDurationMs(file).catch(() => undefined))
  const segments = decoded ? detectSpeechSegments(decoded.channel, decoded.sampleRate) : []

  const specs: MediaSegmentSpec[] =
    segments.length >= 2
      ? segments.map((s) => ({ cellId: uuidv7(), startMs: s.startMs, endMs: s.endMs, trimStartMs: s.startMs, trimEndMs: s.endMs }))
      : [{ cellId: uuidv7(), ...(durationMs !== undefined ? { startMs: 0, endMs: Math.round(durationMs) } : {}) }]
  return { durationMs, specs }
}

/**
 * Import an audio/video FILE as a single media segment on a time-ordered file.
 * Scope A "B-option": one clip spanning the whole file (silence-split into many
 * segments is Part B). Creates file.create (orderedBy='time') + one
 * source.cell.create (medium='media', timing = probed duration), uploads the
 * bytes to R2, and attaches them so the clip is playable in the media layer.
 */
export async function emitMediaFile(
  file: File,
  fileType: FileType,
  ctx: ImportContext,
): Promise<FileReference> {
  const fileId = uuidv7()
  const { durationMs, specs } = await computeMediaSegmentSpecs(file)

  const cells: BulkImportCell[] = specs.map((s, i) => ({
    id: uuidv7(),
    cellId: s.cellId,
    anchorCellId: i === 0 ? null : specs[i - 1].cellId,
    value: file.name,
    medium: "media",
    sequenceIndex: i,
    ...(s.startMs !== undefined && s.endMs !== undefined ? { startMs: s.startMs, endMs: s.endMs } : {}),
  }))

  await bulkUploadSource({
    projectId: ctx.projectId,
    fileId,
    file: {
      id: uuidv7(),
      name: file.name,
      fileType,
      role: "source",
      kind: fileType,
      importFormat: fileType,
      parserVersion: "workspace-import-v1",
      sourceLanguage: ctx.sourceLanguage,
      targetLanguage: ctx.targetLanguage,
      sourceTextDirection: ctx.sourceTextDirection,
      targetTextDirection: ctx.targetTextDirection,
      orderedBy: "time",
    },
    cells,
    getToken: ctx.getToken,
    onProgress: ctx.onCellEnqueued,
    signal: ctx.signal,
  })

  // Upload the media bytes ONCE, then attach the shared clip to each segment
  // cell with its trim window. Slot 'recording' is reused for the source clip;
  // a dedicated source-media slot is a later refinement.
  const ext = (file.name.split(".").pop() || "bin").toLowerCase()
  const audioId = buildAudioId(fileId)
  const upload = await uploadCellAudio({
    projectId: ctx.projectId,
    fileId,
    audioId,
    ext,
    blob: file,
    getSyncToken: (_p, f) => ctx.getToken(f),
  })
  try {
    for (const s of specs) {
      await emitCellAudioAttach({
        projectId: ctx.projectId,
        fileId,
        cellId: s.cellId,
        audioId: upload.audioId,
        url: upload.url,
        slot: "recording",
        ...(file.type ? { mimeType: file.type } : {}),
        ...(durationMs !== undefined ? { durationMs: Math.round(durationMs) } : {}),
        ...(s.trimStartMs !== undefined && s.trimEndMs !== undefined
          ? { trimStartMs: s.trimStartMs, trimEndMs: s.trimEndMs }
          : {}),
        author: ctx.author,
      })
    }
  } catch (err) {
    // The bytes landed but an attach event failed → clean up the orphan.
    await deleteCellAudio({ projectId: ctx.projectId, fileId, audioId, ext, getSyncToken: (_p, f) => ctx.getToken(f) })
    throw err
  }

  return {
    id: fileId,
    name: file.name,
    type: fileType,
    createdAt: new Date().toISOString(),
    cellCount: cells.length,
    orderedBy: "time",
  }
}

/**
 * Decode an audio file to mono PCM for silence-splitting. Returns null when
 * the platform can't decode it (no AudioContext, or an undecodable container
 * such as most video) — callers then fall back to a single whole-file segment.
 */
async function decodeAudioFile(
  file: File,
): Promise<{ channel: Float32Array; sampleRate: number; durationMs: number } | null> {
  const AC: typeof AudioContext | undefined =
    typeof window !== "undefined"
      ? window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      : undefined
  if (!AC) return null
  const buf = await file.arrayBuffer()
  const audioCtx = new AC()
  try {
    const audio = await audioCtx.decodeAudioData(buf)
    return {
      channel: audio.getChannelData(0),
      sampleRate: audio.sampleRate,
      durationMs: audio.duration * 1000,
    }
  } finally {
    void audioCtx.close?.()
  }
}

/**
 * Probe a media file's duration (ms) by loading it into a media element.
 * Rejects on failure; callers treat that as "unknown timing" (the segment is
 * flagged untimed, never given synthetic timecodes).
 */
export function probeMediaDurationMs(file: File): Promise<number> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const isVideo = file.type.startsWith("video/")
    const el = document.createElement(isVideo ? "video" : "audio")
    const cleanup = () => URL.revokeObjectURL(url)
    el.preload = "metadata"
    el.onloadedmetadata = () => {
      const sec = el.duration
      cleanup()
      if (Number.isFinite(sec) && sec > 0) resolve(sec * 1000)
      else reject(new Error("media duration unavailable"))
    }
    el.onerror = () => {
      cleanup()
      reject(new Error("failed to load media metadata"))
    }
    el.src = url
  })
}

export interface ParatextImportProgress {
  phase: "parse" | "save"
  /** Localized name of the book currently being imported. */
  book?: string
  booksDone: number
  booksTotal: number
  /** Cells uploaded so far / total across the whole import (per-chunk
   *  granularity from the bulk uploader) — drives a smooth progress bar
   *  instead of one tick per book. Absent during the parse phase. */
  cellsDone?: number
  cellsTotal?: number
}

/** One book parsed and ready to commit — preview metadata plus the exact
 *  strings the commit phase will upload (parsed once, client-side). */
export interface ParatextBookPlan {
  book: ParatextBook
  strings: TranslatableString[]
  /** Verse refs that appear more than once in the book (surfaced in preview). */
  duplicateRefs: string[]
  cellCount: number
}

/** A fully client-side-parsed Paratext project: everything the preview screen
 *  needs, and everything the commit phase uploads. Nothing has touched the
 *  network when this exists (AQU-310 preview-before-confirm). */
export interface ParatextPlan {
  project: ParatextProject
  books: ParatextBookPlan[]
}

/**
 * Parse a Paratext project entirely client-side — no uploads. Fast (pure
 * parsing), so the dialog can show a preview of every book's cells before the
 * user confirms the import.
 */
export async function prepareParatextProject(entries: ProjectEntry[]): Promise<ParatextPlan> {
  const project = await assembleParatextProject(entries)
  if (!project) {
    throw new Error(
      "That doesn't look like a Paratext project — no Settings.xml (or .ssf) with USFM books was found.",
    )
  }
  const books: ParatextBookPlan[] = project.books.map((book) => {
    const { strings, duplicateRefs } = usfmSectionToStrings(book.rawSource)
    return { book, strings, duplicateRefs, cellCount: strings.length }
  })
  return { project, books }
}

export interface ParatextImportResult {
  refs: FileReference[]
  settings: ParatextSettings
  /** Books whose import failed, with the reason — surfaced so a consultant
   *  knows exactly what didn't come across (rather than a silent drop). */
  skipped: { book: string; reason: string }[]
}

/**
 * Import a whole Paratext project (a set of entries: Settings.xml, BookNames.xml,
 * and the SFM book files — from a folder selection or an unzipped archive).
 *
 * Each book becomes one Aquilla File, named in the project's own language
 * (BookNames), ordered canonically, tagged OT/NT, with the original bytes kept
 * as the round-trip side-car and the original filename retained. The project's
 * language/ISO/direction come back in `settings` so the caller can stamp them
 * on the Aquilla project.
 */
export async function importParatextProject(
  entries: ProjectEntry[],
  ctx: ImportContext,
  onProgress?: (p: ParatextImportProgress) => void,
): Promise<ParatextImportResult> {
  onProgress?.({ phase: "parse", booksDone: 0, booksTotal: 0 })
  const plan = await prepareParatextProject(entries)
  return commitParatextProject(plan, ctx, onProgress)
}

/**
 * Upload a prepared (client-side-parsed, user-confirmed) Paratext plan: each
 * book becomes one Aquilla File via the bulk endpoint. Progress fires per
 * upload chunk (cellsDone/cellsTotal across the whole plan), not just per
 * book, so the dialog bar moves every couple of seconds even on big books.
 */
export async function commitParatextProject(
  plan: ParatextPlan,
  ctx: ImportContext,
  onProgress?: (p: ParatextImportProgress) => void,
): Promise<ParatextImportResult> {
  const refs: FileReference[] = []
  const skipped: { book: string; reason: string }[] = []
  const total = plan.books.length
  // Source language defaults to the project's ISO code so the Aquilla project
  // inherits it (caller may override per source/target choice).
  const baseCtx: ImportContext = {
    ...ctx,
    sourceLanguage: plan.project.settings.languageIsoCode || ctx.sourceLanguage,
    sourceTextDirection: plan.project.settings.rightToLeft ? "rtl" : ctx.sourceTextDirection,
  }
  const isSkipped = (bookId: string) => ctx.skipKeys?.has(bookId.toUpperCase()) ?? false
  const cellsTotal = plan.books.reduce(
    (n, b) => n + (isSkipped(b.book.bookId) ? 0 : b.cellCount),
    0,
  )

  let done = 0
  let cellsUploaded = 0
  for (const bookPlan of plan.books) {
    const book = bookPlan.book
    onProgress?.({
      phase: "save", book: book.displayName, booksDone: done, booksTotal: total,
      cellsDone: cellsUploaded, cellsTotal,
    })
    // AQU-287 / preview toggles: honour skip decisions.
    if (isSkipped(book.bookId)) {
      skipped.push({ book: book.displayName, reason: "skipped by user" })
      done++
      onProgress?.({ phase: "save", booksDone: done, booksTotal: total, cellsDone: cellsUploaded, cellsTotal })
      continue
    }
    try {
      const cellsBefore = cellsUploaded
      const bookCtx: ImportContext = {
        ...baseCtx,
        onCellEnqueued: (uploaded, totalForBook) => {
          onProgress?.({
            phase: "save", book: book.displayName, booksDone: done, booksTotal: total,
            cellsDone: cellsBefore + uploaded, cellsTotal,
          })
          ctx.onCellEnqueued?.(uploaded, totalForBook)
        },
      }
      // USFM books have no speaker tags — ignore speakerPairs.
      const { ref } = await emitParsedFile(
        {
          name: book.displayName,
          strings: bookPlan.strings,
          rawSource: book.rawSource,
          rawSourceFormat: "usfm",
          bookCode: book.bookId,
          corpusMarker: book.corpusMarker,
          originalName: book.fileName,
        },
        "usfm",
        bookCtx,
      )
      refs.push(ref)
      cellsUploaded = cellsBefore + bookPlan.cellCount
    } catch (err) {
      skipped.push({ book: book.displayName, reason: err instanceof Error ? err.message : String(err) })
    }
    done++
    onProgress?.({ phase: "save", book: book.displayName, booksDone: done, booksTotal: total, cellsDone: cellsUploaded, cellsTotal })
  }

  return { refs, settings: plan.project.settings, skipped }
}

/**
 * Import a Paratext project as a TARGET (the consultant's in-progress
 * translation) paired against a chosen SOURCE Bible (eBible). Each book
 * becomes one bilingual file: source cells carry the reference text, target
 * cells carry the translation, paired by verse ref (shared cellId). The
 * target Paratext bytes are kept as the round-trip export side-car.
 *
 * "Close, not precise": verses present on only one side just leave the other
 * blank, so a low-resource target imports cleanly against an approximate
 * source.
 */
export async function importParatextAsTarget(
  plan: ParatextPlan,
  sourceVerses: SourceVerse[],
  ctx: ImportContext,
  onProgress?: (p: ParatextImportProgress) => void,
): Promise<ParatextImportResult> {
  const project = plan.project
  const plans = buildBilingualPlan(project.books, sourceVerses, project.bookNames)
  const refs: FileReference[] = []
  const skipped: { book: string; reason: string }[] = []
  const total = plans.length
  const isSkipped = (bookId: string) => ctx.skipKeys?.has(bookId.toUpperCase()) ?? false
  // Overall cell budget: source cells + target commits per non-skipped book.
  const cellsTotal = plans.reduce(
    (n, p) =>
      n + (isSkipped(p.bookId) ? 0 : p.cells.length + p.cells.filter((c) => c.targetText).length),
    0,
  )
  let cellsUploaded = 0
  let done = 0

  for (const bookPlan of plans) {
    onProgress?.({
      phase: "save", book: bookPlan.displayName, booksDone: done, booksTotal: total,
      cellsDone: cellsUploaded, cellsTotal,
    })
    // AQU-287 / preview toggles: honour skip decisions.
    if (isSkipped(bookPlan.bookId)) {
      skipped.push({ book: bookPlan.displayName, reason: "skipped by user" })
      done++
      onProgress?.({ phase: "save", booksDone: done, booksTotal: total, cellsDone: cellsUploaded, cellsTotal })
      continue
    }
    try {
      const fileId = uuidv7()
      // Source cells (reference text), chained; remember each source cell's
      // event id so the paired target commit can use it as its AD-2 parent.
      const cells: BulkImportCell[] = []
      const targets: TargetCommit[] = []
      let prevCellId: string | null = null
      for (const c of bookPlan.cells) {
        const sourceEventId = uuidv7()
        cells.push({
          id: sourceEventId,
          cellId: c.cellId,
          anchorCellId: prevCellId,
          value: c.sourceText,
          type: "verse",
          canonicalRef: c.ref,
        })
        prevCellId = c.cellId
        if (c.targetText) {
          targets.push({ id: uuidv7(), cellId: c.cellId, parentId: sourceEventId, value: c.targetText })
        }
      }

      const cellsBefore = cellsUploaded
      const bookProgress = (uploaded: number) => {
        onProgress?.({
          phase: "save", book: bookPlan.displayName, booksDone: done, booksTotal: total,
          cellsDone: cellsBefore + uploaded, cellsTotal,
        })
      }

      await bulkUploadSource({
        projectId: ctx.projectId,
        fileId,
        file: {
          id: uuidv7(),
          name: bookPlan.displayName,
          fileType: "usfm",
          role: "target",
          kind: "usfm",
          importFormat: "usfm",
          parserVersion: "paratext-target-v1",
          sourceLanguage: ctx.sourceLanguage,
          targetLanguage: ctx.targetLanguage,
          targetTextDirection: plan.project.settings.rightToLeft ? "rtl" : ctx.targetTextDirection,
          bookCode: bookPlan.bookId,
        },
        cells,
        rawSource: bookPlan.rawSource,
        rawSourceFormat: "usfm",
        getToken: ctx.getToken,
        onProgress: (uploaded) => bookProgress(uploaded),
        signal: ctx.signal,
      })

      await enqueueTargetCommits({
        projectId: ctx.projectId,
        fileId,
        author: ctx.author,
        commits: targets,
        getToken: ctx.getToken,
        onProgress: (uploaded) => bookProgress(cells.length + uploaded),
        signal: ctx.signal,
      })

      refs.push({
        id: fileId,
        name: bookPlan.displayName,
        type: "usfm",
        createdAt: new Date().toISOString(),
        cellCount: cells.length,
        ...(ctx.sourceLanguage ? { sourceLanguage: ctx.sourceLanguage } : {}),
        ...(ctx.targetLanguage ? { targetLanguage: ctx.targetLanguage } : {}),
        ...(plan.project.settings.rightToLeft ? { targetTextDirection: "rtl" as const } : {}),
        ...(bookPlan.corpusMarker ? { corpusMarker: bookPlan.corpusMarker } : {}),
      })
      cellsUploaded = cellsBefore + cells.length + targets.length
    } catch (err) {
      skipped.push({ book: bookPlan.displayName, reason: err instanceof Error ? err.message : String(err) })
    }
    done++
    onProgress?.({ phase: "save", book: bookPlan.displayName, booksDone: done, booksTotal: total, cellsDone: cellsUploaded, cellsTotal })
  }

  return { refs, settings: project.settings, skipped }
}

export async function parseFile(file: File, fileType: FileType): Promise<ImportResult[]> {
  switch (fileType) {
    case "txt":
    case "md":
    case "obs":
    case "vtt":
    case "srt":
    case "csv":
    case "tsv": {
      // DOM-free text formats parse off the main thread so a large import never
      // freezes the UI. The worker client falls back to inline parsing when a
      // worker can't be created (SSR / tests). Per-format logic + the multi-book
      // USFM split live in parse-text-formats.ts (worker-safe core).
      const text = await file.text()
      return parseTextFormatOffMainThread({ fileType, text, name: file.name })
    }
    case "usfm": {
      const raw = await file.text()
      // USX (Paratext's XML export) → USFM conversion uses the Window-only
      // DOMParser, so it runs HERE on the main thread; the heavy lossless parse
      // (verse extraction, \id book split, side-car capture) then happens in the
      // worker via parse-text-formats.ts.
      const text = looksLikeUsx(raw) ? usxToUsfm(raw) : raw
      return parseTextFormatOffMainThread({ fileType: "usfm", text, name: file.name })
    }
    case "docx": {
      const buffer = await file.arrayBuffer()
      const strings = await extractDocxStrings(buffer)
      // Preserve raw bytes as the round-trip side-car so a future server-side
      // DOCX serializer can inject translations back into the original markup.
      // Guard: D1 TEXT rows are capped at ~1 MB; skip side-car for files above
      // 512 KB (base64 overhead ~1.37×) to avoid exceeding that limit.
      const rawSource = buffer.byteLength <= 512 * 1024
        ? arrayBufferToBase64(buffer)
        : undefined
      return [{ name: file.name, strings, rawSource, rawSourceFormat: rawSource ? "docx" : undefined }]
    }
    case "pptx": {
      const buffer = await file.arrayBuffer()
      const strings = await extractPptxStrings(buffer)
      // Same side-car strategy as DOCX above.
      const rawSource = buffer.byteLength <= 512 * 1024
        ? arrayBufferToBase64(buffer)
        : undefined
      return [{ name: file.name, strings, rawSource, rawSourceFormat: rawSource ? "pptx" : undefined }]
    }
    case "xliff": {
      const text = await file.text()
      return [{ name: file.name, strings: parseXliff(text) }]
    }
    case "tmx": {
      const text = await file.text()
      return [{ name: file.name, strings: parseTmx(text) }]
    }
    case "ebible":
      throw new Error("eBible translations import via importEBible(), not importFile()")
    case "helloao":
      throw new Error("Hello AO translations import via importHelloao(), not importFile()")
    case "sdbh":
      throw new Error("SDBH lexicon editions import via importSdbh(), not importFile()")
    case "audio":
    case "video":
      // Media files have no text parser; importFile() routes them to
      // emitMediaFile() before reaching here. Defensive guard.
      throw new Error("media files import via emitMediaFile(), not parseFile()")
  }
}
