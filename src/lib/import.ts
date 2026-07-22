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
import { buildAudioId, MAX_AUDIO_UPLOAD_BYTES, uploadCellAudio } from "./audio/upload"
import { detectSpeechSegments } from "./timeline/silence-split"
import { parseTextFormatOffMainThread } from "./parsers/parse-worker-client"
import { usfmSectionToStrings } from "./parsers/parse-text-formats"
import {
  assembleParatextProject,
  type ParatextBook,
  type ParatextProject,
  type ProjectEntry,
  type ProjectEntryCollection,
  type ProjectSourceArtifact,
} from "./parsers/paratext-project"
import { buildBilingualPlan, type SourceVerse } from "./parsers/paratext-pairing"
import type { ParatextSettings } from "./parsers/paratext"
import { usxToUsfm, looksLikeUsx } from "./parsers/usx"
import {
  enqueueTargetCommitBatch,
  bulkUploadMorphRows,
  publishStagedImport,
  reconcileSourceImport,
  type MorphRow,
  type TargetCommit,
} from "./sync/bulk-import"
import { extractDocxStrings } from "./parsers/docx"
import { extractPptxStrings } from "./parsers/pptx"
import { extractHtmlStrings } from "./parsers/html"
import { bulkUploadSource, type BulkImportCell } from "./sync/bulk-import"
import {
  assertSourceUploadByteLength,
  assertSourceUploadSize,
  bindSourceArtifact,
  uploadSourceOriginal,
} from "./sync/source-upload"
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
import {
  aquillaImportMetadata,
  normalizeTranslatableStrings,
  summarizeNormalizedImport,
  type NormalizedImportFile,
} from "./import/normalized-manifest"
import { ImportService } from "./import/import-service"
import type { ImportPreviewNotice, PreparedImportFile } from "./import/import-service"
import {
  classifyAndParseUnknownText,
  readUnknownTextFile,
  shouldUseAiForKnownText,
  sniffKnownTextFile,
  decodeImportText,
  type AiImportClassification,
} from "./import/ai-recipe"
import type { DeclarativeImportRecipe } from "./import/normalized-manifest"
import type {
  RoundTripFidelity,
  SourceArtifactFormat,
} from "../../shared/import-contract"
import { parseUnknownFileInSandbox } from "./import/sandbox-parser"

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
  /** Exact imported payload retained until the user confirms the target write. */
  sourceArtifact?: TargetImportArtifact
}

export type EBibleTargetPhase = "download" | "parse" | "match" | "save"
export interface EBibleTargetProgress {
  phase: EBibleTargetPhase
  received?: number
  total?: number
  cellsEnqueued?: number
  cellsTotal?: number
}

export interface TargetImportArtifact {
  name: string
  bytes: ArrayBuffer
  format: SourceArtifactFormat
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
  return {
    ...matchEBibleToSourceCells(verses, sourceCells),
    sourceArtifact: {
      name: `${translation.id}.txt`,
      bytes: new TextEncoder().encode(corpusText).buffer as ArrayBuffer,
      format: "ebible",
    },
  }
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
  ctx: Pick<ImportContext, "projectId" | "author" | "getToken" | "signal" | "targetLang"> & {
    sourceArtifact?: TargetImportArtifact
  },
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

  const groups = [...byFile].map(([fileId, cells]) => ({
    fileId,
    commits: cells
      .filter((cell) => cell.parentId)
      .map((cell) => ({
        id: uuidv7(),
        cellId: cell.cellId,
        parentId: cell.parentId!,
        value: cell.incomingText,
      })),
  })).filter((group) => group.commits.length > 0)
  const committedCount = groups.reduce((count, group) => count + group.commits.length, 0)

  // Preserve the exact target-side input before queuing any edits. One
  // immutable artifact can bind to several Aquilla files, and the active lane
  // is part of every binding so later audit/export never confuses languages.
  const sourceArtifact = ctx.sourceArtifact ?? matchResult.sourceArtifact
  if (sourceArtifact && groups.length > 0) {
    const [firstFileId, ...otherFileIds] = groups.map((group) => group.fileId)
    const artifactId = uuidv7()
    await uploadSourceOriginal({
      projectId: ctx.projectId,
      fileId: firstFileId,
      artifactId,
      bytes: sourceArtifact.bytes,
      format: sourceArtifact.format,
      artifactName: sourceArtifact.name,
      bindingRole: "target",
      targetLang: ctx.targetLang,
      profileId: `builtin:target-${sourceArtifact.format}`,
      profileVersion: "1",
      fidelity: "preserved-only",
      updateSourceSidecar: false,
      getToken: ctx.getToken,
      signal: ctx.signal,
    })
    for (const fileId of otherFileIds) {
      await bindSourceArtifact({
        projectId: ctx.projectId,
        fileId,
        artifactId,
        memberPath: sourceArtifact.name,
        profileId: `builtin:target-${sourceArtifact.format}`,
        profileVersion: "1",
        fidelity: "preserved-only",
        bindingRole: "target",
        targetLang: ctx.targetLang,
        getToken: ctx.getToken,
        signal: ctx.signal,
      })
    }
  }

  onProgress?.({ phase: "save", cellsEnqueued: 0, cellsTotal: committedCount })
  await enqueueTargetCommitBatch({
    projectId: ctx.projectId,
    author: ctx.author,
    targetLang: ctx.targetLang,
    groups,
    getToken: ctx.getToken,
    signal: ctx.signal,
    onProgress: (count) => {
      onProgress?.({ phase: "save", cellsEnqueued: count, cellsTotal: committedCount })
    },
  })

  const skippedCount = matchResult.matched.length - committedCount
  return { committedCount, skippedCount }
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
 * Encode an ArrayBuffer to a base64 string. Retained because the acceptance
 * parity suite imports it; the DOCX/PPTX import path no longer base64-encodes
 * source bytes — it uploads the raw bytes to R2 via
 * PUT …/files/{fileId}/source (see `rawBytes` below).
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
  rawSourceFormat?: SourceArtifactFormat
  /** Raw binary bytes for binary formats (DOCX, PPTX). Uploaded directly to R2
   *  via PUT …/files/{fileId}/source instead of being base64-encoded in the
   *  import event payload. Not subject to the old 512 KB cap. */
  rawBytes?: ArrayBuffer
  /** USFM book code (\id), when known. Persisted on the file projection so the
   *  sidebar can group + order by canonical book. */
  bookCode?: string
  /** OT/NT grouping for the sidebar. */
  corpusMarker?: "OT" | "NT" | undefined
  /** Original filename (e.g. "01GENarONAV12.SFM") — preserved for export naming
   *  and hover-to-see-original when we rename the file to a localized book name. */
  originalName?: string
  /** AI-assisted unknown-format recipe, shown in preview and persisted. */
  importRecipe?: DeclarativeImportRecipe
  importClassification?: Omit<AiImportClassification, "recipe"> & { recipe: DeclarativeImportRecipe }
  importNotices?: ImportPreviewNotice[]
  roundTripFidelity?: RoundTripFidelity
  /** Exact container for a multi-book import. Stored once and bound to every
   * emitted book instead of becoming every book's export skeleton. */
  sharedSourceArtifact?: TargetImportArtifact
}

export interface ImportContext {
  projectId: string
  /** Authoring user id; events carry this as `author`. Per AD-2, system-emitted
   *  imports use the triggering admin's user id, not a synthetic 'system'. */
  author: string
  /** Optional language pair to stamp on the `file.create` payload. */
  sourceLanguage?: string
  targetLanguage?: string
  /** Target-lane storage key. Empty/absent means the project's default lane. */
  targetLang?: string
  /** Identity JWT used only for AI-assisted classification of unknown text. */
  identityToken?: string
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
  /** Existing files selected for safe unit-identity reconciliation. Keys use
   * the same normalized book-code/name vocabulary as skipKeys. */
  reimportFileIds?: ReadonlyMap<string, string>
  /** Advanced orchestrators can keep fresh files hidden while persisting
   * package-level or format-specific secondary data. */
  deferPublication?: boolean
}

type PrepareImportContext = Pick<
  ImportContext,
  "projectId" | "identityToken" | "sourceLanguage" | "targetLanguage" | "signal"
>

function preparedParsedFile(
  file: File,
  fileType: FileType,
  results: ImportResult[],
): PreparedImportFile {
  if (results.length === 0 || results.every((result) => result.strings.length === 0)) {
    throw new Error(`${file.name} did not contain any content the ${fileType} adapter could import.`)
  }
  return { fileType, results }
}

async function prepareSandboxImport(
  file: File,
  ctx: PrepareImportContext & { identityToken: string },
  firstError: unknown,
  retainedBytes?: ArrayBuffer,
): Promise<PreparedImportFile> {
  const sandboxed = await parseUnknownFileInSandbox(file, {
    identityToken: ctx.identityToken,
    projectId: ctx.projectId,
    sourceLanguage: ctx.sourceLanguage,
    targetLanguage: ctx.targetLanguage,
    signal: ctx.signal,
  }).catch((sandboxError) => {
    const first = firstError instanceof Error ? firstError.message : String(firstError)
    const second = sandboxError instanceof Error ? sandboxError.message : String(sandboxError)
    throw new Error(`${first}. Sandbox fallback also failed: ${second}`)
  })
  return {
    fileType: "custom",
    results: [{
      name: file.name,
      strings: sandboxed.strings,
      rawBytes: retainedBytes ?? await file.arrayBuffer(),
      rawSourceFormat: "custom-original",
      importRecipe: sandboxed.classification.recipe,
      importClassification: sandboxed.classification,
    }],
  }
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
  skipped?: { book: string; reason: string }[]
}

/** Stable domain kind is intentionally distinct from the parser/extension.
 * TMX files participate in translation-memory retrieval even though their
 * deterministic parser id remains `tmx`. */
export function importedFileKind(fileType: FileType): string {
  return fileType === "tmx" ? "translation-memory" : fileType
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
  prepared?: PreparedImportFile,
): Promise<ImportFileResult> {
  const service = new ImportService<ImportContext, FileReference>({
    detectFileType,
    isMediaFileType,
    parseFile,
    emitMediaFile,
    emitParsedFile,
  })
  const ready = prepared ?? await prepareImportFile(file, ctx)
  const sharedArtifact = ready.results.find((result) => result.sharedSourceArtifact)?.sharedSourceArtifact
  const multiResult = ready.results.length > 1
  const imported = await service.importFile(
    file,
    multiResult ? { ...ctx, deferPublication: true } : ctx,
    ready,
  )
  if (!multiResult) return { refs: imported.refs, speakerPairs: imported.speakerPairs }

  if (sharedArtifact && imported.refs.length > 0) {
    const artifactId = uuidv7()
    await uploadSourceOriginal({
      projectId: ctx.projectId,
      fileId: imported.refs[0].id,
      artifactId,
      artifactName: sharedArtifact.name,
      bytes: sharedArtifact.bytes,
      format: sharedArtifact.format,
      bindingRole: "support",
      memberPath: imported.refs[0].name,
      profileId: `builtin:multi-${sharedArtifact.format}`,
      profileVersion: "1",
      fidelity: "preserved-only",
      updateSourceSidecar: false,
      getToken: ctx.getToken,
      signal: ctx.signal,
    })
    for (const ref of imported.refs.slice(1)) {
      await bindSourceArtifact({
        projectId: ctx.projectId,
        fileId: ref.id,
        artifactId,
        memberPath: ref.name,
        profileId: `builtin:multi-${sharedArtifact.format}`,
        profileVersion: "1",
        fidelity: "preserved-only",
        getToken: ctx.getToken,
        signal: ctx.signal,
      })
    }
  }

  const existingFileIds = new Set(ctx.reimportFileIds?.values() ?? [])
  const refs: FileReference[] = []
  const skipped: { book: string; reason: string }[] = []
  for (const ref of imported.refs) {
    if (existingFileIds.has(ref.id)) {
      refs.push(ref)
      continue
    }
    try {
      await publishStagedImport({
        projectId: ctx.projectId,
        fileId: ref.id,
        getToken: ctx.getToken,
        signal: ctx.signal,
      })
      refs.push(ref)
    } catch (error) {
      skipped.push({
        book: ref.name,
        reason: `publication failed: ${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }
  if (refs.length === 0 && skipped.length > 0) {
    throw new Error(`Import could not publish any files: ${skipped[0].reason}`)
  }
  return { refs, speakerPairs: imported.speakerPairs, ...(skipped.length ? { skipped } : {}) }
}

/** Parse/classify exactly once so preview and commit use the same immutable
 * recipe and parsed units. Deterministic content sniffing precedes AI. */
export async function prepareImportFile(
  file: File,
  ctx: PrepareImportContext,
): Promise<PreparedImportFile> {
  if (file.size === 0) throw new Error(`${file.name} is empty.`)
  // Fail before parsing/decompression and before any server event. The same
  // ceiling is enforced again by the artifact route as a trust boundary.
  assertSourceUploadByteLength(file.size)
  const extensionType = detectFileType(file.name)
  if (extensionType) {
    // Opaque packages/media need their deterministic binary adapter. Textual
    // extensions are sniffed as content first so a USFM document named .txt,
    // or an XLIFF named .xml by an upstream tool, is not flattened as prose.
    if (isMediaFileType(extensionType)) return { fileType: extensionType, results: [] }
    try {
      if (extensionType === "docx" || extensionType === "pptx") {
        return preparedParsedFile(file, extensionType, await parseFile(file, extensionType))
      }
      const bytes = await file.arrayBuffer()
      const text = decodeImportText(bytes, file.name)
      const sniffedType = sniffKnownTextFile(text)
      const fileType = sniffedType ?? extensionType
      let analysisError: unknown
      if (
        ctx.identityToken
        && sniffedType === null
        && shouldUseAiForKnownText(fileType, text)
      ) {
        try {
          const assisted = await classifyAndParseUnknownText(file, {
            identityToken: ctx.identityToken,
            projectId: ctx.projectId,
            sourceLanguage: ctx.sourceLanguage,
            targetLanguage: ctx.targetLanguage,
            signal: ctx.signal,
          }, { text, bytes })
          return {
            fileType: "custom",
            results: [{
              name: file.name,
              strings: assisted.strings,
              rawBytes: bytes,
              rawSourceFormat: "custom-original",
              importRecipe: assisted.classification.recipe,
              importClassification: assisted.classification,
            }],
          }
        } catch (error) {
          // A well-defined built-in parser is still a safe fallback when model
          // infrastructure is unavailable. Make that downgrade explicit in the
          // mandatory preview instead of failing or silently flattening data.
          analysisError = error
        }
      }
      const prepared = preparedParsedFile(file, fileType, await parseFile(file, fileType))
      if (analysisError) {
        prepared.results = prepared.results.map((result) => ({
          ...result,
          importNotices: [{
            code: "basic-parser-fallback",
            severity: "warning",
            message: "Aquilla could not verify this structured layout with AI, so it used the basic parser. Check the preview carefully before importing.",
          }],
        }))
      }
      return prepared
    } catch (error) {
      if (!ctx.identityToken) throw error
      return prepareSandboxImport(file, { ...ctx, identityToken: ctx.identityToken }, error)
    }
  }

  let inspected: Awaited<ReturnType<typeof readUnknownTextFile>> | undefined
  let declarativeError: unknown
  try {
    inspected = await readUnknownTextFile(file, ctx.signal)
    const sniffedType = sniffKnownTextFile(inspected.text)
    if (sniffedType) {
      return preparedParsedFile(file, sniffedType, await parseFile(file, sniffedType))
    }
    if (!ctx.identityToken) {
      throw new Error(`Unsupported file type: ${file.name}. Sign in to use AI-assisted format detection.`)
    }
    const assisted = await classifyAndParseUnknownText(file, {
      identityToken: ctx.identityToken,
      projectId: ctx.projectId,
      sourceLanguage: ctx.sourceLanguage,
      targetLanguage: ctx.targetLanguage,
      signal: ctx.signal,
    }, inspected)
    return {
      fileType: "custom",
      results: [{
        name: file.name,
        strings: assisted.strings,
        rawBytes: inspected.bytes,
        rawSourceFormat: "custom-original",
        importRecipe: assisted.classification.recipe,
        importClassification: assisted.classification,
      }],
    }
  } catch (error) {
    declarativeError = error
  }
  if (!ctx.identityToken) throw declarativeError

  // The safe declarative recipe is the preferred AI path. Only formats it
  // cannot decode or express are escalated to generated code, and that code
  // executes in the isolated import sandbox—not in this browser/runtime.
  return prepareSandboxImport(
    file,
    { ...ctx, identityToken: ctx.identityToken },
    declarativeError,
    inspected?.bytes,
  )
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
    { name: fileName, strings, rawSource: corpusText, rawSourceFormat: "ebible" },
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
  const failed: string[] = []
  for (let i = 0; i < mdFiles.length; i++) {
    if (signal?.aborted) throw new Error("Import cancelled")
    const item = mdFiles[i]
    const rawUrl = `${OBS_REPO.baseUrl}/${OBS_REPO.owner}/${OBS_REPO.repo}/raw/branch/${OBS_REPO.branch}/${item.path}`
    const fileRes = await fetch(rawUrl, { signal })
    if (!fileRes.ok) {
      failed.push(`${item.name} (${fileRes.status})`)
      continue
    }
    out.push({ name: item.name, content: await fileRes.text() })
    onProgress?.(i + 1, mdFiles.length)
  }
  if (failed.length > 0) {
    throw new Error(`Open Bible Stories download was incomplete: ${failed.join(", ")}. Nothing was imported.`)
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
    {
      name: fileName,
      strings,
      rawSource: JSON.stringify(storyFiles),
      rawSourceFormat: "obs-package",
    },
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

  let rawComplete = ""
  const complete = await fetchHelloaoComplete(
    translation.id,
    (received, total) => onProgress?.({ phase: "download", received, total }),
    signal,
    (raw) => { rawComplete = raw },
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
    {
      name: fileName,
      strings,
      rawSource: rawComplete || JSON.stringify(complete),
      rawSourceFormat: "helloao",
    },
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

  assertSourceUploadByteLength(file.size)
  const rawBytes = await file.arrayBuffer()
  const text = decodeImportText(rawBytes, file.name)
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
    rawBytes,
    rawSourceFormat: "macula-tsv",
    deferPublication: true,
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

  // Morphology is required data for this format. Keep the file staged until
  // every row is durable; a failure remains retryable and never exposes a
  // deceptively complete source file.
  if (allMorphRows.length > 0) {
    onProgress?.({ phase: "morph", morphEnqueued: 0, morphTotal: allMorphRows.length })
    await bulkUploadMorphRows({
      projectId: ctx.projectId,
      fileId,
      rows: allMorphRows,
      getToken: ctx.getToken,
      onProgress: (count, total) => {
        onProgress?.({ phase: "morph", morphEnqueued: count, morphTotal: total })
      },
    })
  }

  await publishStagedImport({ projectId: ctx.projectId, fileId, getToken: ctx.getToken })

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

  assertSourceUploadByteLength(file.size)
  const rawBytes = await file.arrayBuffer()
  const text = decodeImportText(rawBytes, file.name)
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
    rawBytes,
    rawSourceFormat: "tn-tsv",
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
}
export function buildBulkCellsWithSpeakers(
  strings: TranslatableString[],
  options: {
    fileName?: string
    fileType?: FileType
    profileId?: string
    profileVersion?: string
    normalizedFile?: NormalizedImportFile
  },
): {
  cells: BulkImportCell[]
  speakerPairs: { cellId: string; speaker: string | undefined }[]
}
export function buildBulkCellsWithSpeakers(
  strings: TranslatableString[],
  options: {
    fileName?: string
    fileType?: FileType
    profileId?: string
    profileVersion?: string
    normalizedFile?: NormalizedImportFile
  } = {},
): {
  cells: BulkImportCell[]
  speakerPairs: { cellId: string; speaker: string | undefined }[]
} {
  const normalizedFile = options.normalizedFile ?? normalizeTranslatableStrings(strings, {
    fileName: options.fileName ?? "import",
    fileType: options.fileType ?? "txt",
    profileId: options.profileId,
    profileVersion: options.profileVersion,
  })
  if (normalizedFile.units.length !== strings.length) {
    throw new Error("Normalized import unit count does not match parsed string count")
  }
  const cells: BulkImportCell[] = []
  const speakerPairs: { cellId: string; speaker: string | undefined }[] = []
  let prevCellId: string | null = null
  for (let seq = 0; seq < strings.length; seq++) {
    const str = strings[seq]
    const unit = normalizedFile.units[seq]
    const cellId = str.id || uuidv7()
    const metadata = {
      ...(str.metadata ?? {}),
      aquillaImport: aquillaImportMetadata(normalizedFile, unit),
    }
    cells.push({
      id: uuidv7(),
      cellId,
      anchorCellId: prevCellId,
      value: unit.sourceText,
      ...(unit.sourceHtml ? { valueHtml: unit.sourceHtml } : {}),
      ...(str.type !== undefined ? { type: str.type } : {}),
      ...(unit.canonicalRef ? { canonicalRef: unit.canonicalRef } : {}),
      ...(unit.startMs !== undefined && unit.endMs !== undefined ? { startMs: unit.startMs, endMs: unit.endMs } : {}),
      // Timeline-segment-model: intrinsic order key (import order). For
      // time-ordered files it is the tiebreak / home for untimed rows; for
      // sequence-ordered files it IS the order. `medium` defaults to 'text'
      // (absent), so only an explicit media import needs to set it.
      sequenceIndex: unit.physicalOrder,
      ...(str.medium ? { medium: str.medium } : {}),
      ...(str.paragraphStart ? { paragraphStart: true } : {}),
      // Extensible per-cell metadata (OBS frame attachments today). Threaded
      // into the bulk POST body verbatim → cells.metadata JSONB on the server.
      metadata,
    })
    speakerPairs.push({ cellId, speaker: str.speaker })
    prevCellId = cellId
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
  normalizedFile?: NormalizedImportFile,
): Promise<EmitParsedFileResult> {
  const reimportKeys = [
    result.bookCode?.trim().toUpperCase(),
    result.name.trim().toLowerCase(),
    result.originalName?.trim().toLowerCase(),
  ].filter((key): key is string => Boolean(key))
  const existingFileId = reimportKeys
    .map((key) => ctx.reimportFileIds?.get(key))
    .find((id): id is string => Boolean(id))
  const fileId = existingFileId ?? uuidv7()

  const normalized = normalizedFile ?? normalizeTranslatableStrings(result.strings, {
    fileName: result.name,
    fileType,
    profileId: fileType === "usfm" ? "builtin:usfm-lossless" : `builtin:${fileType}`,
    profileVersion: "1",
  })

  // Chain cells via anchorCellId: the first cell's anchor is null (genesis —
  // first in file); each subsequent cell anchors on the prior cell's id.
  // Use buildBulkCellsWithSpeakers so we capture speakerPairs from the SAME
  // call that mints the cellIds — avoids the double-parse cellId mismatch.
  const { cells, speakerPairs } = buildBulkCellsWithSpeakers(result.strings, {
    normalizedFile: normalized,
  })
  const targets: TargetCommit[] = cells.flatMap((cell, index) => {
    const value = result.strings[index]?.translated
    return value
      ? [{ id: uuidv7(), cellId: cell.cellId, parentId: cell.id, value }]
      : []
  })

  // Timeline-segment-model: subtitle imports are time-true (their cues carry
  // timecodes and the timeline is the spine); every text/document format is
  // sequence-true. Absent ⇒ the client treats a file as 'sequence', so we only
  // need to mark the time-ordered case explicitly.
  const orderedBy: OrderedBy = orderedByForFileType(fileType)

  const upload = existingFileId ? reconcileSourceImport : bulkUploadSource
  await upload({
    projectId: ctx.projectId,
    fileId,
    file: {
      id: uuidv7(),
      name: result.name,
      fileType,
      role: "source",
      kind: importedFileKind(fileType),
      importFormat: fileType,
      parserVersion: `${normalized.profileId}@${normalized.profileVersion}`,
      importManifest: summarizeNormalizedImport(normalized),
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
    rawBytes: result.rawBytes,
    artifactFidelity: normalized.fidelity,
    targets,
    targetLang: ctx.targetLang,
    ...(!existingFileId && ctx.deferPublication ? { deferPublication: true } : {}),
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
      ...(normalized.units.some((unit) => (
        unit.address?.scheme === "scripture" || unit.address?.scheme === "scripture-structure"
      ))
        ? { hasScriptureContent: true }
        : {}),
      ...(ctx.sourceLanguage ? { sourceLanguage: ctx.sourceLanguage } : {}),
      ...(ctx.targetLanguage ? { targetLanguage: ctx.targetLanguage } : {}),
      ...(ctx.sourceTextDirection ? { sourceTextDirection: ctx.sourceTextDirection } : {}),
      ...(ctx.targetTextDirection ? { targetTextDirection: ctx.targetTextDirection } : {}),
      ...(result.corpusMarker ? { corpusMarker: result.corpusMarker } : {}),
      ...(result.originalName ? { originalName: result.originalName } : {}),
      ...(result.bookCode ? { bookCode: result.bookCode } : {}),
    },
    speakerPairs,
  }
}

/** Subtitle + media formats are time-ordered (the timeline is the spine);
 *  every text/document format is sequence-ordered. */
export function orderedByForFileType(fileType: FileType): OrderedBy {
  return fileType === "vtt" || fileType === "srt" || fileType === "sbv" || isMediaFileType(fileType)
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
  if (file.size === 0) throw new Error(`${file.name} is empty.`)
  if (file.size > MAX_AUDIO_UPLOAD_BYTES) {
    throw new Error(`${file.name} exceeds the 95 MB media import limit.`)
  }
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
      kind: importedFileKind(fileType),
      importFormat: fileType,
      parserVersion: "workspace-import-v1",
      sourceLanguage: ctx.sourceLanguage,
      targetLanguage: ctx.targetLanguage,
      sourceTextDirection: ctx.sourceTextDirection,
      targetTextDirection: ctx.targetTextDirection,
      orderedBy: "time",
    },
    cells,
    deferPublication: true,
    getToken: ctx.getToken,
    onProgress: ctx.onCellEnqueued,
    signal: ctx.signal,
  })

  // Upload the media bytes ONCE, then attach the shared clip to each segment
  // cell with its trim window. Slot 'recording' is reused for the source clip;
  // a dedicated source-media slot is a later refinement.
  const ext = (file.name.split(".").pop() || "bin").toLowerCase()
  const audioId = buildAudioId(fileId)
  const artifactId = uuidv7()
  const upload = await uploadCellAudio({
    projectId: ctx.projectId,
    fileId,
    audioId,
    ext,
    blob: file,
    artifactId,
    artifactName: file.name,
    getSyncToken: (_p, f) => ctx.getToken(f),
    signal: ctx.signal,
  })
  // Persist every attachment and reveal the staged file in one worker
  // transaction. If the response is lost after commit, publishStagedImport
  // retries the same event ids; never delete the clip on an ambiguous publish
  // failure because the server may already have made it live.
  await publishStagedImport({
    projectId: ctx.projectId,
    fileId,
    attachments: specs.map((s) => ({
      cellId: s.cellId,
      audioId: `${upload.audioId}.${upload.ext}`,
      url: upload.url,
      slot: "recording",
      ...(file.type ? { mimeType: file.type } : {}),
      ...(durationMs !== undefined ? { durationMs: Math.round(durationMs) } : {}),
      ...(s.trimStartMs !== undefined && s.trimEndMs !== undefined
        ? { trimStartMs: s.trimStartMs, trimEndMs: s.trimEndMs }
        : {}),
    })),
    getToken: ctx.getToken,
    signal: ctx.signal,
  })

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
    // decodeAudioData rejects with a cryptic DOMException ("EncodingError:
    // Decoding failed") — rewrap so anything that surfaces or logs the message
    // is user-actionable. The original error is preserved as `cause`.
    const audio = await audioCtx.decodeAudioData(buf).catch((err: unknown) => {
      throw new Error(
        `Couldn't decode ${file.name} — the file may be corrupt or in an unsupported codec. Try re-exporting it as mp3 or wav.`,
        { cause: err },
      )
    })
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
  /** Whole ZIP/folder package, including Settings, BookNames, support files,
   * and any media members. One immutable artifact binds to every book file. */
  sourceArtifact?: ProjectSourceArtifact
}

/**
 * Parse a Paratext project entirely client-side — no uploads. Fast (pure
 * parsing), so the dialog can show a preview of every book's cells before the
 * user confirms the import.
 */
export async function prepareParatextProject(entries: ProjectEntryCollection): Promise<ParatextPlan> {
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
  // Materialize and validate the complete package during preview. Commit then
  // uploads these exact immutable bytes; a large folder-derived ZIP cannot
  // fail only after book files have already been staged.
  let sourceArtifact: ProjectSourceArtifact | undefined
  if (entries.sourceArtifact) {
    const bytes = await entries.sourceArtifact.bytes()
    assertSourceUploadSize(bytes)
    sourceArtifact = { ...entries.sourceArtifact, bytes: async () => bytes }
  }
  return { project, books, ...(sourceArtifact ? { sourceArtifact } : {}) }
}

async function preserveParatextPackage(
  plan: ParatextPlan,
  bindings: Array<{ fileId: string; memberPath: string }>,
  ctx: Pick<ImportContext, "projectId" | "getToken" | "signal">,
  options: { bindingRole?: "support" | "target"; targetLang?: string } = {},
): Promise<void> {
  if (!plan.sourceArtifact || bindings.length === 0) return
  const artifactId = uuidv7()
  const bytes = await plan.sourceArtifact.bytes()
  await uploadSourceOriginal({
    projectId: ctx.projectId,
    fileId: bindings[0].fileId,
    artifactId,
    artifactName: plan.sourceArtifact.name,
    bytes,
    format: plan.sourceArtifact.format,
    bindingRole: options.bindingRole ?? "support",
    targetLang: options.targetLang,
    memberPath: bindings[0].memberPath,
    profileId: "builtin:paratext-project",
    profileVersion: "1",
    fidelity: "preserved-only",
    updateSourceSidecar: false,
    getToken: ctx.getToken,
    signal: ctx.signal,
  })
  for (const binding of bindings.slice(1)) {
    await bindSourceArtifact({
      projectId: ctx.projectId,
      fileId: binding.fileId,
      artifactId,
      memberPath: binding.memberPath,
      profileId: "builtin:paratext-project",
      profileVersion: "1",
      fidelity: "preserved-only",
      bindingRole: options.bindingRole,
      targetLang: options.targetLang,
      getToken: ctx.getToken,
      signal: ctx.signal,
    })
  }
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
    deferPublication: true,
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
  const existingFileIds = new Set(ctx.reimportFileIds?.values() ?? [])
  const packageBindings: Array<{ fileId: string; memberPath: string }> = []
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
      packageBindings.push({ fileId: ref.id, memberPath: book.fileName })
      cellsUploaded = cellsBefore + bookPlan.cellCount
    } catch (err) {
      skipped.push({ book: book.displayName, reason: err instanceof Error ? err.message : String(err) })
    }
    done++
    onProgress?.({ phase: "save", book: book.displayName, booksDone: done, booksTotal: total, cellsDone: cellsUploaded, cellsTotal })
  }

  let packagePreservationError: string | null = null
  try {
    await preserveParatextPackage(plan, packageBindings, baseCtx)
  } catch (error) {
    packagePreservationError = error instanceof Error ? error.message : String(error)
  }
  const visibleRefs: FileReference[] = []
  const freshRefs = refs.filter((ref) => !existingFileIds.has(ref.id))
  if (packagePreservationError && freshRefs.length === 0) {
    skipped.push({
      book: plan.sourceArtifact?.name ?? "Paratext package",
      reason: `package preservation failed: ${packagePreservationError}`,
    })
  }
  for (const ref of refs) {
    if (existingFileIds.has(ref.id)) {
      visibleRefs.push(ref)
      continue
    }
    if (packagePreservationError) {
      skipped.push({
        book: ref.name,
        reason: `not published because package preservation failed: ${packagePreservationError}`,
      })
      continue
    }
    try {
      await publishStagedImport({
        projectId: ctx.projectId,
        fileId: ref.id,
        getToken: ctx.getToken,
        signal: ctx.signal,
      })
      visibleRefs.push(ref)
    } catch (error) {
      skipped.push({
        book: ref.name,
        reason: `publication failed: ${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }

  return { refs: visibleRefs, settings: plan.project.settings, skipped }
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
  const existingFileIds = new Set(ctx.reimportFileIds?.values() ?? [])
  const packageBindings: Array<{ fileId: string; memberPath: string }> = []

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
      const existingFileId = ctx.reimportFileIds?.get(bookPlan.bookId.toUpperCase())
      const fileId = existingFileId ?? uuidv7()
      const strings: TranslatableString[] = bookPlan.cells.map((cell) => ({
        id: cell.cellId,
        original: cell.sourceText,
        translated: cell.targetText,
        context: cell.ref,
        group: cell.ref,
        globalReferences: [cell.ref],
        type: cell.type,
        ...(cell.paragraphStart ? { paragraphStart: true } : {}),
      }))
      const normalized = normalizeTranslatableStrings(strings, {
        fileName: bookPlan.displayName,
        fileType: "usfm",
        profileId: "builtin:paratext-bilingual",
        profileVersion: "1",
      })
      // Compile source and target from one normalized unit list. Headings stay
      // structural/unnumbered and both sides share the same semantic unit key.
      const { cells } = buildBulkCellsWithSpeakers(strings, { normalizedFile: normalized })
      const targets: TargetCommit[] = cells.flatMap((cell, index) => {
        const value = bookPlan.cells[index].targetText
        return value
          ? [{ id: uuidv7(), cellId: cell.cellId, parentId: cell.id, value }]
          : []
      })

      const cellsBefore = cellsUploaded
      const bookProgress = (uploaded: number) => {
        onProgress?.({
          phase: "save", book: bookPlan.displayName, booksDone: done, booksTotal: total,
          cellsDone: cellsBefore + uploaded, cellsTotal,
        })
      }

      const upload = existingFileId ? reconcileSourceImport : bulkUploadSource
      await upload({
        projectId: ctx.projectId,
        fileId,
        file: {
          id: uuidv7(),
          name: bookPlan.displayName,
          fileType: "usfm",
          role: "target",
          kind: "usfm",
          importFormat: "usfm",
          parserVersion: `${normalized.profileId}@${normalized.profileVersion}`,
          importManifest: summarizeNormalizedImport(normalized),
          sourceLanguage: ctx.sourceLanguage,
          targetLanguage: ctx.targetLanguage,
          targetTextDirection: plan.project.settings.rightToLeft ? "rtl" : ctx.targetTextDirection,
          bookCode: bookPlan.bookId,
        },
        cells,
        rawSource: bookPlan.rawSource,
        rawSourceFormat: "usfm",
        artifactBindingRole: "target",
        artifactTargetLang: ctx.targetLang,
        updateSourceSidecar: true,
        artifactFidelity: "native",
        targets,
        targetLang: ctx.targetLang,
        ...(!existingFileId ? { deferPublication: true } : {}),
        getToken: ctx.getToken,
        onProgress: (uploaded) => bookProgress(uploaded),
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
        bookCode: bookPlan.bookId,
      })
      packageBindings.push({
        fileId,
        memberPath: plan.project.books.find((book) => book.bookId === bookPlan.bookId)?.fileName ?? `${bookPlan.bookId}.SFM`,
      })
      cellsUploaded = cellsBefore + cells.length + targets.length
    } catch (err) {
      skipped.push({ book: bookPlan.displayName, reason: err instanceof Error ? err.message : String(err) })
    }
    done++
    onProgress?.({ phase: "save", book: bookPlan.displayName, booksDone: done, booksTotal: total, cellsDone: cellsUploaded, cellsTotal })
  }

  let packagePreservationError: string | null = null
  try {
    await preserveParatextPackage(plan, packageBindings, ctx, {
      bindingRole: "target",
      targetLang: ctx.targetLang,
    })
  } catch (error) {
    packagePreservationError = error instanceof Error ? error.message : String(error)
  }

  const visibleRefs: FileReference[] = []
  const freshRefs = refs.filter((ref) => !existingFileIds.has(ref.id))
  if (packagePreservationError && freshRefs.length === 0) {
    skipped.push({
      book: plan.sourceArtifact?.name ?? "Paratext package",
      reason: `package preservation failed: ${packagePreservationError}`,
    })
  }
  for (const ref of refs) {
    if (existingFileIds.has(ref.id)) {
      visibleRefs.push(ref)
      continue
    }
    if (packagePreservationError) {
      skipped.push({
        book: ref.name,
        reason: `not published because package preservation failed: ${packagePreservationError}`,
      })
      continue
    }
    try {
      await publishStagedImport({
        projectId: ctx.projectId,
        fileId: ref.id,
        getToken: ctx.getToken,
        signal: ctx.signal,
      })
      visibleRefs.push(ref)
    } catch (error) {
      skipped.push({
        book: ref.name,
        reason: `publication failed: ${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }

  return { refs: visibleRefs, settings: project.settings, skipped }
}

export async function parseFile(file: File, fileType: FileType): Promise<ImportResult[]> {
  switch (fileType) {
    case "txt":
    case "md":
    case "json":
    case "po":
    case "properties":
    case "obs":
    case "vtt":
    case "srt":
    case "sbv":
    case "csv":
    case "tsv": {
      // DOM-free text formats parse off the main thread so a large import never
      // freezes the UI. The worker client falls back to inline parsing when a
      // worker can't be created (SSR / tests). Per-format logic + the multi-book
      // USFM split live in parse-text-formats.ts (worker-safe core).
      const bytes = await file.arrayBuffer()
      const text = decodeImportText(bytes, file.name)
      const parsed = await parseTextFormatOffMainThread({ fileType, text, name: file.name })
      return parsed.map((result) => ({
        ...result,
        rawBytes: bytes,
        rawSourceFormat: fileType,
      }))
    }
    case "usfm": {
      const bytes = await file.arrayBuffer()
      const raw = decodeImportText(bytes, file.name)
      // USX (Paratext's XML export) → USFM conversion uses the Window-only
      // DOMParser, so it runs HERE on the main thread; the heavy lossless parse
      // (verse extraction, \id book split, side-car capture) then happens in the
      // worker via parse-text-formats.ts.
      const isUsx = looksLikeUsx(raw)
      const text = isUsx ? usxToUsfm(raw) : raw
      const results = await parseTextFormatOffMainThread({ fileType: "usfm", text, name: file.name })
      if (results.length > 1) {
        return results.map((result, index) => ({
          ...result,
          // Each Aquilla book needs its own valid export skeleton. The exact
          // original bundle is retained separately and bound to every book.
          rawSourceFormat: "usfm",
          roundTripFidelity: "content-only" as const,
          ...(index === 0 ? {
            sharedSourceArtifact: {
              name: file.name,
              bytes,
              format: isUsx ? "usx" : "usfm",
            },
          } : {}),
        }))
      }
      return isUsx
        ? results.map((result) => ({
            ...result,
            rawBytes: bytes,
            rawSourceFormat: "usx",
          }))
        : results.map((result) => ({
            ...result,
            rawBytes: bytes,
            rawSourceFormat: "usfm",
          }))
    }
    case "docx": {
      const buffer = await file.arrayBuffer()
      const strings = await extractDocxStrings(buffer)
      // Upload raw bytes to R2 via PUT …/files/{fileId}/source (no 512 KB cap).
      return [{ name: file.name, strings, rawBytes: buffer, rawSourceFormat: "docx" }]
    }
    case "pptx": {
      const buffer = await file.arrayBuffer()
      const strings = await extractPptxStrings(buffer)
      // Upload raw bytes to R2 via PUT …/files/{fileId}/source (no 512 KB cap).
      return [{ name: file.name, strings, rawBytes: buffer, rawSourceFormat: "pptx" }]
    }
    case "xlsx":
      throw new Error("XLSX files import through spreadsheet column mapping")
    case "html": {
      const bytes = await file.arrayBuffer()
      const text = decodeImportText(bytes, file.name)
      return [{ name: file.name, strings: extractHtmlStrings(text), rawBytes: bytes, rawSourceFormat: "html" }]
    }
    case "xliff": {
      const bytes = await file.arrayBuffer()
      const text = decodeImportText(bytes, file.name)
      return [{ name: file.name, strings: parseXliff(text), rawBytes: bytes, rawSourceFormat: "xliff" }]
    }
    case "tmx": {
      const bytes = await file.arrayBuffer()
      const text = decodeImportText(bytes, file.name)
      return [{ name: file.name, strings: parseTmx(text), rawBytes: bytes, rawSourceFormat: "tmx" }]
    }
    case "ebible":
      throw new Error("eBible translations import via importEBible(), not importFile()")
    case "helloao":
      throw new Error("Hello AO translations import via importHelloao(), not importFile()")
    case "sdbh":
      throw new Error("SDBH lexicon editions import via importSdbh(), not importFile()")
    case "custom":
      throw new Error("Custom formats must be prepared by the AI-assisted recipe service")
    case "audio":
    case "video":
      // Media files have no text parser; importFile() routes them to
      // emitMediaFile() before reaching here. Defensive guard.
      throw new Error("media files import via emitMediaFile(), not parseFile()")
  }
}
