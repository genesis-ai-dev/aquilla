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
import { extractPlaintextStrings } from "./parsers/plaintext"
import { extractMarkdownStrings } from "./parsers/markdown"
import { extractVttStrings, extractSrtStrings } from "./parsers/subtitle"
import { parseUsfmLossless } from "./parsers/usfm-lossless"
import {
  assembleParatextProject,
  type ProjectEntry,
} from "./parsers/paratext-project"
import { buildBilingualPlan, type SourceVerse } from "./parsers/paratext-pairing"
import type { ParatextSettings } from "./parsers/paratext"
import { usxToUsfm, looksLikeUsx } from "./parsers/usx"
import { bulkUploadTargetCommits, type TargetCommit } from "./sync/bulk-import"
import { extractDocxStrings } from "./parsers/docx"
import { extractPptxStrings } from "./parsers/pptx"
import { bulkUploadSource, type BulkImportCell } from "./sync/bulk-import"
import {
  fetchTranslationText,
  parseEBibleCorpus,
  type EBibleTranslation,
} from "./parsers/ebible"
import { parseXliff } from "./parsers/xliff"
import { parseTmx } from "./parsers/tmx"
import { parseCsvBilingual } from "./parsers/csv-bilingual"

export type EBibleImportPhase = "download" | "parse" | "save"
export interface EBibleProgress {
  phase: EBibleImportPhase
  received?: number
  total?: number
  /** During the "save" phase: cells uploaded so far / total. */
  cellsEnqueued?: number
  cellsTotal?: number
}

/**
 * Encode an ArrayBuffer to a base64 string. Used to capture binary source
 * blobs (DOCX, PPTX) as the round-trip side-car — the same mechanism USFM
 * uses for text. The server stores this in `file_source_blobs.raw_source`
 * (a TEXT column); the export route decodes it to reconstruct the original
 * file with translations substituted.
 */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ""
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

interface ImportResult {
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

/** Parse one USFM book section into translatable cells (verse bodies + heading/
 *  title/intro paratext), in document order. Shared by plain-USFM import and
 *  Paratext-project import. */
function usfmSectionToStrings(section: string): {
  bookId: string
  strings: TranslatableString[]
  duplicateRefs: string[]
} {
  const doc = parseUsfmLossless(section)
  const bookId = doc.bookId || "unknown"
  const seen = new Set<string>()
  const duplicateRefs: string[] = []
  for (const v of doc.verses) {
    if (seen.has(v.ref)) duplicateRefs.push(v.ref)
    else seen.add(v.ref)
  }
  const allSpans = [
    ...doc.verses.map((v) => ({
      order: v.textStart,
      ref: v.ref,
      text: v.text.trim(),
      section: `${bookId} ${v.chapter}`,
      type: "verse" as const,
    })),
    ...doc.headings.map((h) => ({
      order: h.textStart,
      ref: h.ref,
      text: h.text.trim(),
      section: h.chapter > 0 ? `${bookId} ${h.chapter}` : bookId,
      type: h.kind,
    })),
  ].sort((a, b) => a.order - b.order)
  const strings: TranslatableString[] = allSpans.map((s) => ({
    id: uuidv7(),
    original: s.text,
    translated: "",
    context: s.ref,
    group: s.ref,
    section: s.section,
    globalReferences: [s.ref],
    type: s.type,
  }))
  return { bookId, strings, duplicateRefs }
}

export interface ImportContext {
  projectId: string
  /** Authoring user id; events carry this as `author`. Per AD-2, system-emitted
   *  imports use the triggering admin's user id, not a synthetic 'system'. */
  author: string
  /** Optional language pair to stamp on the `file.create` payload. */
  sourceLanguage?: string
  targetLanguage?: string
  /** Mints a sync-token scoped to (projectId, fileId) for the bulk upload. */
  getToken: (fileId: string) => Promise<string | null>
  /** Fired as cells upload — drives the dialog progress UI. */
  onCellEnqueued?: (uploaded: number, total: number) => void
  /** Aborts the in-flight upload (dialog close / cancel). */
  signal?: AbortSignal
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

  const results = await parseFile(file, fileType)
  const refs: FileReference[] = []
  const speakerPairs: { cellId: string; speaker: string | undefined }[] = []

  for (const result of results) {
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

  // Part B: decode the audio and split it into per-line media segments at
  // silences. Fall back to a single whole-file segment when decode fails
  // (e.g. a video container we can't decode here) or the split yields ≤1
  // region. Never synthesize timing — a fallback segment uses the real probed
  // duration, or is left untimed (editor flags it) if even that fails.
  const decoded = await decodeAudioFile(file).catch(() => null)
  const durationMs = decoded?.durationMs ?? (await probeMediaDurationMs(file).catch(() => undefined))
  const segments = decoded ? detectSpeechSegments(decoded.channel, decoded.sampleRate) : []

  // One spec per segment, else one whole-file spec. `trim*Ms` is each segment's
  // window into the shared clip (we upload the bytes once, not N times).
  const specs: { cellId: string; startMs?: number; endMs?: number; trimStartMs?: number; trimEndMs?: number }[] =
    segments.length >= 2
      ? segments.map((s) => ({ cellId: uuidv7(), startMs: s.startMs, endMs: s.endMs, trimStartMs: s.startMs, trimEndMs: s.endMs }))
      : [{ cellId: uuidv7(), ...(durationMs !== undefined ? { startMs: 0, endMs: Math.round(durationMs) } : {}) }]

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
  const project = await assembleParatextProject(entries)
  if (!project) {
    throw new Error(
      "That doesn't look like a Paratext project — no Settings.xml (or .ssf) with USFM books was found.",
    )
  }

  const refs: FileReference[] = []
  const skipped: { book: string; reason: string }[] = []
  const total = project.books.length
  // Source language defaults to the project's ISO code so the Aquilla project
  // inherits it (caller may override per source/target choice).
  const bookCtx: ImportContext = {
    ...ctx,
    sourceLanguage: project.settings.languageIsoCode || ctx.sourceLanguage,
  }

  let done = 0
  for (const book of project.books) {
    onProgress?.({ phase: "parse", book: book.displayName, booksDone: done, booksTotal: total })
    try {
      const { strings } = usfmSectionToStrings(book.rawSource)
      // USFM books have no speaker tags — ignore speakerPairs.
      const { ref } = await emitParsedFile(
        {
          name: book.displayName,
          strings,
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
    } catch (err) {
      skipped.push({ book: book.displayName, reason: err instanceof Error ? err.message : String(err) })
    }
    done++
    onProgress?.({ phase: "save", booksDone: done, booksTotal: total })
  }

  return { refs, settings: project.settings, skipped }
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
  entries: ProjectEntry[],
  sourceVerses: SourceVerse[],
  ctx: ImportContext,
  onProgress?: (p: ParatextImportProgress) => void,
): Promise<ParatextImportResult> {
  const project = await assembleParatextProject(entries)
  if (!project) {
    throw new Error(
      "That doesn't look like a Paratext project — no Settings.xml (or .ssf) with USFM books was found.",
    )
  }
  const plans = buildBilingualPlan(project.books, sourceVerses, project.bookNames)
  const refs: FileReference[] = []
  const skipped: { book: string; reason: string }[] = []
  const total = plans.length
  let done = 0

  for (const plan of plans) {
    onProgress?.({ phase: "parse", book: plan.displayName, booksDone: done, booksTotal: total })
    try {
      const fileId = uuidv7()
      // Source cells (reference text), chained; remember each source cell's
      // event id so the paired target commit can use it as its AD-2 parent.
      const cells: BulkImportCell[] = []
      const targets: TargetCommit[] = []
      let prevCellId: string | null = null
      for (const c of plan.cells) {
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

      await bulkUploadSource({
        projectId: ctx.projectId,
        fileId,
        file: {
          id: uuidv7(),
          name: plan.displayName,
          fileType: "usfm",
          role: "target",
          kind: "usfm",
          importFormat: "usfm",
          parserVersion: "paratext-target-v1",
          sourceLanguage: ctx.sourceLanguage,
          targetLanguage: ctx.targetLanguage,
          bookCode: plan.bookId,
        },
        cells,
        rawSource: plan.rawSource,
        rawSourceFormat: "usfm",
        getToken: ctx.getToken,
        signal: ctx.signal,
      })

      await bulkUploadTargetCommits({
        projectId: ctx.projectId,
        fileId,
        author: ctx.author,
        commits: targets,
        getToken: ctx.getToken,
        signal: ctx.signal,
      })

      refs.push({
        id: fileId,
        name: plan.displayName,
        type: "usfm",
        createdAt: new Date().toISOString(),
        cellCount: cells.length,
        ...(plan.corpusMarker ? { corpusMarker: plan.corpusMarker } : {}),
      })
    } catch (err) {
      skipped.push({ book: plan.displayName, reason: err instanceof Error ? err.message : String(err) })
    }
    done++
    onProgress?.({ phase: "save", booksDone: done, booksTotal: total })
  }

  return { refs, settings: project.settings, skipped }
}

async function parseFile(file: File, fileType: FileType): Promise<ImportResult[]> {
  switch (fileType) {
    case "txt": {
      const text = await file.text()
      return [{ name: file.name, strings: extractPlaintextStrings(text) }]
    }
    case "md": {
      const text = await file.text()
      return [{ name: file.name, strings: extractMarkdownStrings(text) }]
    }
    case "vtt": {
      const text = await file.text()
      return [{ name: file.name, strings: extractVttStrings(text) }]
    }
    case "srt": {
      const text = await file.text()
      return [{ name: file.name, strings: extractSrtStrings(text) }]
    }
    case "usfm": {
      const raw = await file.text()
      // USX (Paratext's XML export) is isomorphic to USFM — convert it up front
      // and let the proven USFM pipeline take over (cells + side-car).
      const text = looksLikeUsx(raw) ? usxToUsfm(raw) : raw
      // Use the lossless parser: clean verse text (no leaked inline footnote
      // markers like the legacy parser produced), stable canonical refs
      // (`MAT 1:1`), and the raw bytes captured as a side-car so export can
      // round-trip every marker we don't explicitly model.
      //
      // Multi-book files (concatenated with \id boundaries) get split here so
      // each book becomes its own File — matches the legacy behavior and
      // Paratext convention.
      const sections = text.includes("\\id ")
        ? text.split(/(?=\\id\s)/).filter((s) => s.trim().length > 0)
        : [text]
      return sections.map((section) => {
        const { bookId, strings, duplicateRefs } = usfmSectionToStrings(section)
        // Surface duplicate \v refs (a real data-quality issue we see in the
        // wild — e.g. two consecutive `\v 34`). Round-trip still works, but
        // consultants should know their source has the bug.
        if (duplicateRefs.length > 0) {
          console.warn(
            `[usfm import] ${file.name}: ${duplicateRefs.length} duplicate verse ref(s) — `
              + `${duplicateRefs.slice(0, 5).join(", ")}${duplicateRefs.length > 5 ? `, +${duplicateRefs.length - 5} more` : ""}`,
          )
        }
        return {
          name: file.name === bookId ? bookId : sections.length > 1 ? bookId : file.name,
          strings,
          rawSource: section,
          rawSourceFormat: "usfm",
        }
      })
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
    case "csv":
    case "tsv": {
      const text = await file.text()
      return [{ name: file.name, strings: parseCsvBilingual(text) }]
    }
    case "ebible":
      throw new Error("eBible translations import via importEBible(), not importFile()")
    case "audio":
    case "video":
      // Media files have no text parser; importFile() routes them to
      // emitMediaFile() before reaching here. Defensive guard.
      throw new Error("media files import via emitMediaFile(), not parseFile()")
  }
}
