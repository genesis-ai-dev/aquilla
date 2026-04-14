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
      const cell = new Y.Map()
      cell.set("id", str.id)
      cell.set("original", str.original)
      if (str.originalHtml) cell.set("originalHtml", str.originalHtml)
      cell.set("translated", str.translated)
      cell.set("context", str.context)
      cell.set("group", str.group)
      cell.set("type", str.type)
      cell.set("history", new Y.Array())
      if (str.sourceLocation) cell.set("sourceLocation", str.sourceLocation)
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

export interface ValidatedPair {
  source: string
  target: string
}

// Load all human-validated source/target pairs across the given fileIds.
// Waits for each Y.Doc to sync from IndexedDB, reads validated cells, cleans up.
export async function collectValidatedPairs(fileIds: string[]): Promise<ValidatedPair[]> {
  const pairs: ValidatedPair[] = []

  for (const fileId of fileIds) {
    const handle = loadFileDoc(fileId)
    try {
      await new Promise<void>((resolve) => {
        if (handle.persistence.synced) resolve()
        else handle.persistence.once("synced", () => resolve())
      })

      const cellsMap = handle.doc.getMap("cells")
      const orderArray = handle.doc.getArray<string>("order")

      for (const cellId of orderArray.toArray()) {
        const cell = cellsMap.get(cellId) as Y.Map<unknown> | undefined
        if (!cell) continue

        const translated = (cell.get("translated") as string) || ""
        if (!translated.trim()) continue

        const historyArr = cell.get("history") as Y.Array<{ validated: boolean; source: string }> | undefined
        const history = historyArr ? historyArr.toArray() : []
        if (history.length === 0) continue

        const lastEntry = history[history.length - 1]
        if (!lastEntry.validated || lastEntry.source !== "human") continue

        pairs.push({
          source: (cell.get("original") as string) || "",
          target: translated,
        })
      }
    } finally {
      destroyFileDoc(handle)
    }
  }

  return pairs
}

export interface ExportCell {
  id: string
  original: string
  translated: string
  context: string
  group: string
  type: string
  sourceLocation?: { file: string; blockPath: string }
}

export interface ExportData {
  fileId: string
  fileName: string
  fileType: string
  sourceLanguage: string
  targetLanguage: string
  cells: ExportCell[]
}

export async function collectExportCells(fileId: string): Promise<ExportData> {
  const handle = loadFileDoc(fileId)
  try {
    await new Promise<void>((resolve) => {
      if (handle.persistence.synced) resolve()
      else handle.persistence.once("synced", () => resolve())
    })

    const meta = handle.doc.getMap("meta")
    const cellsMap = handle.doc.getMap("cells")
    const orderArray = handle.doc.getArray<string>("order")

    const cells: ExportCell[] = []
    for (const cellId of orderArray.toArray()) {
      const cell = cellsMap.get(cellId) as Y.Map<unknown> | undefined
      if (!cell) continue
      cells.push({
        id: (cell.get("id") as string) || cellId,
        original: (cell.get("original") as string) || "",
        translated: (cell.get("translated") as string) || "",
        context: (cell.get("context") as string) || "",
        group: (cell.get("group") as string) || "",
        type: (cell.get("type") as string) || "text",
        sourceLocation: cell.get("sourceLocation") as { file: string; blockPath: string } | undefined,
      })
    }

    return {
      fileId,
      fileName: (meta.get("fileName") as string) || "untitled",
      fileType: (meta.get("fileType") as string) || "txt",
      sourceLanguage: (meta.get("sourceLanguage") as string) || "",
      targetLanguage: (meta.get("targetLanguage") as string) || "",
      cells,
    }
  } finally {
    destroyFileDoc(handle)
  }
}
