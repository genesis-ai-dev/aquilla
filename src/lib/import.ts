import { v4 as uuid } from "uuid"
import type { FileType, FileReference, TranslatableString } from "./parsers/types"
import { detectFileType } from "./parsers/types"
import { extractPlaintextStrings } from "./parsers/plaintext"
import { extractMarkdownStrings } from "./parsers/markdown"
import { extractVttStrings, extractSrtStrings } from "./parsers/subtitle"
import { extractUsfmStrings } from "./parsers/usfm"
import { extractDocxStrings } from "./parsers/docx"
import { extractPptxStrings } from "./parsers/pptx"
import { createFileDoc, destroyFileDoc } from "./store/file-doc"
import { storeOriginalFile } from "./store/project-index"

interface ImportResult {
  name: string
  strings: TranslatableString[]
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
    const fileId = uuid()
    const handle = createFileDoc(
      fileId,
      result.name,
      fileType,
      sourceLanguage,
      targetLanguage,
      result.strings
    )

    await new Promise<void>((resolve) => {
      if (handle.persistence.synced) {
        resolve()
      } else {
        handle.persistence.once("synced", () => resolve())
      }
    })

    if (fileType === "docx" || fileType === "pptx") {
      await storeOriginalFile(fileId, await file.arrayBuffer())
    }

    refs.push({
      id: fileId,
      name: result.name,
      type: fileType,
      createdAt: new Date().toISOString(),
      cellCount: result.strings.length,
    })

    destroyFileDoc(handle)
  }

  return refs
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
  }
}
