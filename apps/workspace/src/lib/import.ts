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
import type { FileType, FileReference, TranslatableString } from "./parsers/types"
import { detectFileType } from "./parsers/types"
import { extractPlaintextStrings } from "./parsers/plaintext"
import { extractMarkdownStrings } from "./parsers/markdown"
import { extractVttStrings, extractSrtStrings } from "./parsers/subtitle"
import { extractUsfmStrings } from "./parsers/usfm"
import { extractDocxStrings } from "./parsers/docx"
import { extractPptxStrings } from "./parsers/pptx"
import { bulkUploadSource, type BulkImportCell } from "./sync/bulk-import"
import {
  fetchTranslationText,
  parseEBibleCorpus,
  type EBibleTranslation,
} from "./parsers/ebible"

export type EBibleImportPhase = "download" | "parse" | "save"
export interface EBibleProgress {
  phase: EBibleImportPhase
  received?: number
  total?: number
  /** During the "save" phase: cells uploaded so far / total. */
  cellsEnqueued?: number
  cellsTotal?: number
}

interface ImportResult {
  name: string
  strings: TranslatableString[]
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

/**
 * Import a single user-supplied file. Each `ImportResult` (one per book for
 * USFM, one overall for single-blob formats) becomes one Aquilla File with
 * a chain of `source.cell.create` events.
 */
export async function importFile(
  file: File,
  ctx: ImportContext,
): Promise<FileReference[]> {
  const fileType = detectFileType(file.name)
  if (!fileType) {
    throw new Error(`Unsupported file type: ${file.name}`)
  }

  const results = await parseFile(file, fileType)
  const refs: FileReference[] = []

  for (const result of results) {
    const ref = await emitParsedFile(result, fileType, ctx)
    refs.push(ref)
  }

  return refs
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
    throw new Error(`Translation '${translation.id}' produced no verses`)
  }

  onProgress?.({ phase: "save", cellsEnqueued: 0, cellsTotal: strings.length })

  const fileName = `${translation.title} (${translation.id})`

  return emitParsedFile(
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
}

/**
 * Build `file.create` + N chained `source.cell.create` and stream them to the
 * server's bulk-import endpoint. Returns a `FileReference` once every cell has
 * landed. Throws (with a human-readable message) if the upload fails.
 */
export async function emitParsedFile(
  result: ImportResult,
  fileType: FileType,
  ctx: ImportContext,
): Promise<FileReference> {
  const fileId = uuidv7()

  // Chain cells via anchorCellId: the first cell's anchor is null (genesis —
  // first in file); each subsequent cell anchors on the prior cell's id.
  const cells: BulkImportCell[] = []
  let prevCellId: string | null = null
  for (const str of result.strings) {
    // Use the parser-supplied id when present (USFM gives stable verse refs);
    // otherwise mint a fresh UUIDv7.
    const cellId = str.id || uuidv7()
    cells.push({
      id: uuidv7(),
      cellId,
      anchorCellId: prevCellId,
      value: str.original,
      ...(str.originalHtml ? { valueHtml: str.originalHtml } : {}),
      ...(str.type !== undefined ? { type: str.type } : {}),
      ...(str.group ? { canonicalRef: str.group } : {}),
    })
    prevCellId = cellId
  }

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
    },
    cells,
    getToken: ctx.getToken,
    onProgress: ctx.onCellEnqueued,
    signal: ctx.signal,
  })

  return {
    id: fileId,
    name: result.name,
    type: fileType,
    createdAt: new Date().toISOString(),
    cellCount: cells.length,
  }
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
      const text = await file.text()
      const books = extractUsfmStrings(text)
      return books.map((b) => ({ name: b.bookId, strings: b.strings }))
    }
    case "docx": {
      const buffer = await file.arrayBuffer()
      const strings = await extractDocxStrings(buffer)
      return [{ name: file.name, strings }]
    }
    case "pptx": {
      const buffer = await file.arrayBuffer()
      const strings = await extractPptxStrings(buffer)
      return [{ name: file.name, strings }]
    }
    case "ebible":
      throw new Error("eBible translations import via importEBible(), not importFile()")
  }
}
