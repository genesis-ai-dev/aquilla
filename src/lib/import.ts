import { v4 as uuid } from "uuid"
import type { FileType, FileReference, TranslatableString } from "./parsers/types"
import { detectFileType } from "./parsers/types"
import { extractPlaintextStrings } from "./parsers/plaintext"
import { extractMarkdownStrings } from "./parsers/markdown"
import { extractVttStrings, extractSrtStrings } from "./parsers/subtitle"
import { extractUsfmStrings } from "./parsers/usfm"
import { extractDocxStrings } from "./parsers/docx"
import { extractPptxStrings } from "./parsers/pptx"
import {
  createSourceFileDoc,
  createTargetFileDoc,
  destroyFileDoc,
  type FileDocHandle,
} from "./store/file-doc"
import { storeOriginalFile } from "./store/project-index"
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
}

interface ImportResult {
  name: string
  strings: TranslatableString[]
}

async function whenSynced(handle: FileDocHandle): Promise<void> {
  return new Promise<void>((resolve) => {
    if (handle.persistence.synced) resolve()
    else handle.persistence.once("synced", () => resolve())
  })
}

/** Build a paired source + target FileReference for one parsed result.
 *  Cell ids match across the pair so `useCells` can join them later. */
async function buildPairedRefs(
  fileType: FileType,
  baseName: string,
  strings: TranslatableString[],
  sourceLanguage: string,
  targetLanguage: string,
): Promise<{ source: FileReference; target: FileReference }> {
  const sourceFileId = uuid()
  const targetFileId = uuid()
  const createdAt = new Date().toISOString()

  const sourceHandle = createSourceFileDoc(
    sourceFileId,
    baseName,
    fileType,
    sourceLanguage,
    strings,
  )
  const targetHandle = createTargetFileDoc(
    targetFileId,
    baseName,
    fileType,
    sourceLanguage,
    targetLanguage,
    strings.map((s) => ({ id: s.id, translated: s.translated || undefined })),
  )

  await Promise.all([whenSynced(sourceHandle), whenSynced(targetHandle)])
  destroyFileDoc(sourceHandle)
  destroyFileDoc(targetHandle)

  const source: FileReference = {
    id: sourceFileId,
    name: baseName,
    type: fileType,
    createdAt,
    cellCount: strings.length,
    kind: "source",
  }
  const target: FileReference = {
    id: targetFileId,
    name: baseName,
    type: fileType,
    createdAt,
    cellCount: strings.length,
    kind: "target",
    pairing: { sourceFileIds: [sourceFileId] },
  }
  return { source, target }
}

export async function importFile(
  file: File,
  sourceLanguage: string,
  targetLanguage: string
): Promise<FileReference[]> {
  const fileType = detectFileType(file.name)
  if (!fileType) {
    throw new Error(`Unsupported file type: ${file.name}`)
  }

  const results = await parseFile(file, fileType)
  const refs: FileReference[] = []

  for (const result of results) {
    const { source, target } = await buildPairedRefs(
      fileType,
      result.name,
      result.strings,
      sourceLanguage,
      targetLanguage,
    )

    if (fileType === "docx" || fileType === "pptx") {
      // Original-file blob is needed by surgical export, which lives on the
      // source side (export reads source structure + target translation).
      await storeOriginalFile(source.id, await file.arrayBuffer())
    }

    refs.push(source, target)
  }

  return refs
}

export async function importEBible(
  translation: EBibleTranslation,
  sourceLanguage: string,
  targetLanguage: string,
  onProgress?: (p: EBibleProgress) => void,
  signal?: AbortSignal
): Promise<FileReference[]> {
  onProgress?.({ phase: "download", received: 0, total: 0 })

  const corpusText = await fetchTranslationText(
    translation.id,
    (received, total) => onProgress?.({ phase: "download", received, total }),
    signal
  )

  onProgress?.({ phase: "parse" })
  const strings = parseEBibleCorpus(corpusText)
  if (strings.length === 0) {
    throw new Error(`Translation '${translation.id}' produced no verses`)
  }

  onProgress?.({ phase: "save" })

  const fileName = `${translation.title} (${translation.id})`
  const { source, target } = await buildPairedRefs(
    "ebible",
    fileName,
    strings,
    sourceLanguage,
    targetLanguage,
  )

  return [source, target]
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
