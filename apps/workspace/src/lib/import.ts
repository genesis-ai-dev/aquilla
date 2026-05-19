// Phase 2c-β: parsers feed the outbox.
//
// Pre-Phase 2c-β this module wrote into a per-file Y.Doc via createFileDoc
// and persisted to IndexedDB. AD-2 makes the event log the source of truth,
// so after parsing we emit:
//
//   1. file.create (genesis; project-scope)
//   2. one source.cell.create event per parsed cell, chained via
//      anchor_cell_id (the previous cell's id, or null for the first)
//
// The outbox drains the events to the server via WS (primary) or
// `POST /events` (fallback). The cells projection lands as the server
// applies each event.
//
// `originals` (DOCX/PPTX blob storage in IDB) is dropped — AD-4 puts
// imported source blobs in R2; the future re-parse path fetches from R2.
// Locally we no longer keep a copy.

import { v7 as uuidv7 } from "uuid"
import type { FileType, FileReference, TranslatableString } from "./parsers/types"
import { detectFileType } from "./parsers/types"
import { extractPlaintextStrings } from "./parsers/plaintext"
import { extractMarkdownStrings } from "./parsers/markdown"
import { extractVttStrings, extractSrtStrings } from "./parsers/subtitle"
import { extractUsfmStrings } from "./parsers/usfm"
import { extractDocxStrings } from "./parsers/docx"
import { extractPptxStrings } from "./parsers/pptx"
import { emitFileCreate, emitSourceCellCreate } from "./sync/events-emit"
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
  /** New in Phase 2c-β: number of `source.cell.create` events flushed so far. */
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
  /** Optional callback fired per enqueued cell — drives the dialog progress UI. */
  onCellEnqueued?: (count: number, total: number) => void
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
      onCellEnqueued: (count, total) => {
        onProgress?.({ phase: "save", cellsEnqueued: count, cellsTotal: total })
        ctx.onCellEnqueued?.(count, total)
      },
    },
  )
}

/**
 * Emits `file.create` + N `source.cell.create` events into the outbox.
 * Returns a `FileReference` shaped like the legacy API for caller ergonomics.
 */
export async function emitParsedFile(
  result: ImportResult,
  fileType: FileType,
  ctx: ImportContext,
): Promise<FileReference> {
  const fileId = uuidv7()

  await emitFileCreate({
    projectId: ctx.projectId,
    fileId,
    name: result.name,
    fileType,
    role: "source",
    kind: fileType,
    importFormat: fileType,
    parserVersion: "workspace-import-v1",
    sourceLanguage: ctx.sourceLanguage,
    targetLanguage: ctx.targetLanguage,
    author: ctx.author,
  })

  // Chain cells via anchorCellId. The first cell's anchor is null (genesis
  // anchor — first in file); each subsequent cell anchors on the prior id.
  let prevCellId: string | null = null
  let enqueued = 0
  const total = result.strings.length
  for (const str of result.strings) {
    // Use the parser-supplied id when present (USFM gives stable verse refs);
    // otherwise mint a fresh UUIDv7.
    const cellId = str.id || uuidv7()
    await emitSourceCellCreate({
      projectId: ctx.projectId,
      fileId,
      cellId,
      anchorCellId: prevCellId,
      value: str.original,
      ...(str.originalHtml ? { valueHtml: str.originalHtml } : {}),
      type: str.type,
      ...(str.group ? { canonicalRef: str.group } : {}),
      author: ctx.author,
    })
    prevCellId = cellId
    enqueued++
    ctx.onCellEnqueued?.(enqueued, total)
  }

  return {
    id: fileId,
    name: result.name,
    type: fileType,
    createdAt: new Date().toISOString(),
    cellCount: total,
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
