import * as Y from "yjs"
import { IndexeddbPersistence } from "y-indexeddb"
import type { TranslatableString, FileType } from "../parsers/types"

export interface FileDocHandle {
  doc: Y.Doc
  persistence: IndexeddbPersistence
}

export function createFileDoc(
  fileId: string,
  fileName: string,
  fileType: FileType,
  sourceLanguage: string,
  targetLanguage: string,
  strings: TranslatableString[]
): FileDocHandle {
  const doc = new Y.Doc()

  const meta = doc.getMap("meta")
  const cells = doc.getMap("cells")
  const order = doc.getArray<string>("order")

  doc.transact(() => {
    meta.set("fileId", fileId)
    meta.set("fileName", fileName)
    meta.set("fileType", fileType)
    meta.set("sourceLanguage", sourceLanguage)
    meta.set("targetLanguage", targetLanguage)

    for (const str of strings) {
      const cell = new Y.Map<string>()
      cell.set("id", str.id)
      cell.set("original", str.original)
      if (str.originalHtml) cell.set("originalHtml", str.originalHtml)
      cell.set("translated", str.translated)
      cell.set("context", str.context)
      cell.set("group", str.group)
      cell.set("type", str.type)
      cells.set(str.id, cell)
      order.push([str.id])
    }
  })

  const persistence = new IndexeddbPersistence(`codex:file:${fileId}`, doc)
  return { doc, persistence }
}

export function loadFileDoc(fileId: string): FileDocHandle {
  const doc = new Y.Doc()
  const persistence = new IndexeddbPersistence(`codex:file:${fileId}`, doc)
  return { doc, persistence }
}

export function destroyFileDoc(handle: FileDocHandle): void {
  handle.persistence.destroy()
  handle.doc.destroy()
}
