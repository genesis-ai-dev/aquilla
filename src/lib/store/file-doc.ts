import * as Y from "yjs"
import { IndexeddbPersistence } from "y-indexeddb"
import type { TranslatableString, FileType, CellHistoryEntry } from "../parsers/types"
import { getPlainText, getFragmentHtml, setPlainText, setFragmentFromHtml } from "@/lib/richtext/translated-xml"
import { mapEditHistory } from "@/lib/codex-editor/map-history"

function extractCellTranslated(cell: Y.Map<unknown>): string {
  const frag = cell.get("translatedXml") as Y.XmlFragment | undefined
  if (frag) return getPlainText(frag)
  // Legacy fallback for pre-M9 docs that somehow still exist
  return (cell.get("translated") as string) || ""
}

export interface FileDocHandle {
  doc: Y.Doc
  persistence: IndexeddbPersistence
  fileId: string
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
      const translatedXml = new Y.XmlFragment()
      cell.set("translatedXml", translatedXml)
      if (str.translated) setPlainText(translatedXml, str.translated)
      cell.set("context", str.context)
      cell.set("group", str.group)
      if (str.section) cell.set("section", str.section)
      cell.set("type", str.type)
      cell.set("history", new Y.Array())
      if (str.sourceLocation) cell.set("sourceLocation", str.sourceLocation)
      cells.set(str.id, cell)
      order.push([str.id])
    }
  })

  const persistence = new IndexeddbPersistence(`codex:file:${fileId}`, doc)
  // createFileDoc is only called by the importer. It does NOT register with the
  // shared registry — the importer owns the sole reference and destroys it
  // after whenSynced. Registry kicks in for later loadFileDoc calls so editor
  // and sync share one Y.Doc instance.
  return { doc, persistence, fileId }
}

// Shared registry of live handles. Without this, sync's loadFileDoc returned
// a fresh Y.Doc + persistence disjoint from the editor's doc, so syncProject's
// rehydrate wrote through to IDB but the editor's Y.Doc in the same tab kept
// showing pre-merge state. Ref-count so destroyFileDoc from one caller doesn't
// tear down the handle another caller is still using.
interface RegistryEntry {
  handle: FileDocHandle
  refcount: number
}
const registry = new Map<string, RegistryEntry>()

export function loadFileDoc(fileId: string): FileDocHandle {
  const existing = registry.get(fileId)
  if (existing) {
    existing.refcount++
    return existing.handle
  }
  const doc = new Y.Doc()
  const persistence = new IndexeddbPersistence(`codex:file:${fileId}`, doc)
  const handle: FileDocHandle = { doc, persistence, fileId }
  registry.set(fileId, { handle, refcount: 1 })
  return handle
}

export function destroyFileDoc(handle: FileDocHandle): void {
  const entry = registry.get(handle.fileId)
  if (entry && entry.handle === handle) {
    entry.refcount--
    if (entry.refcount > 0) return
    registry.delete(handle.fileId)
  }
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

        const translated = extractCellTranslated(cell)
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

export interface RecentExampleCandidate {
  id: string
  original: string
  translated: string
  validationStatus: "full" | "self" | "none" | "empty" | "others"
  history: { timestamp: string; author: string; validated: boolean }[]
}

/**
 * Load candidate examples for Living Memory's Recent Examples section —
 * cells that have a non-empty translation and at least one validated
 * history entry. Filtering/sorting/limiting is performed by the pure
 * selector `selectRecentValidatedExamples`; this helper's only job is
 * to stream per-cell records across multiple file docs.
 *
 * Mirrors `collectValidatedPairs`' doc-load-and-destroy pattern.
 */
export async function collectRecentExampleCandidates(
  fileIds: string[],
): Promise<RecentExampleCandidate[]> {
  const out: RecentExampleCandidate[] = []

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

        const translated = extractCellTranslated(cell)
        if (!translated.trim()) continue

        const historyArr = cell.get("history") as
          | Y.Array<{ timestamp?: string; author?: string; validated?: boolean }>
          | undefined
        const history = historyArr
          ? historyArr.toArray().map((h) => ({
              timestamp: h.timestamp ?? "",
              author: h.author ?? "",
              validated: !!h.validated,
            }))
          : []
        if (history.length === 0) continue
        const last = history[history.length - 1]
        if (!last.validated) continue

        // We don't have access to the per-user `__source.validatedBy` entries
        // here without extra plumbing; treat any cell whose last history
        // entry is `validated: true` as "full" for selector purposes.
        // Refine later if we need per-user granularity in Living Memory.
        out.push({
          id: cellId,
          original: (cell.get("original") as string) || "",
          translated,
          validationStatus: "full",
          history,
        })
      }
    } finally {
      destroyFileDoc(handle)
    }
  }

  return out
}

export interface ExportCell {
  id: string
  original: string
  translated: string
  translatedHtml?: string
  context: string
  group: string
  type: string
  sourceLocation?: { file: string; blockPath: string }
  backtranslation?: string
  backtranslationUpdatedAt?: string
  backtranslationForText?: string
}

export interface ExportData {
  fileId: string
  fileName: string
  fileType: string
  sourceLanguage: string
  targetLanguage: string
  cells: ExportCell[]
}

// --- Phase 3: rehydration from merged notebook bytes ---

/**
 * Replace a live Y.Doc's cell state from a parsed merged notebook, inside a
 * single transact() so IndexeddbPersistence writes through once. Cells keep
 * their Y.Map identity where possible (open editors don't blow away their
 * bindings). `__source` is replaced with the merged cell JSON — future
 * serializeCell calls will see the merged edit ledger as canonical.
 */
export function rehydrateFileDoc(
  doc: Y.Doc,
  merged: import("@/lib/codex-editor/types").CodexNotebookFile,
  syncedAt: number,
): void {
  doc.transact(() => {
    const cellsMap = doc.getMap("cells")
    const order = doc.getArray<string>("order")
    const meta = doc.getMap("meta")

    const mergedIds = new Set(merged.cells.map((c) => c.metadata.id))
    for (const id of [...cellsMap.keys()]) {
      if (!mergedIds.has(id)) cellsMap.delete(id)
    }

    for (const cell of merged.cells) {
      const id = cell.metadata.id
      let yCell = cellsMap.get(id) as Y.Map<unknown> | undefined
      if (!yCell) {
        yCell = new Y.Map<unknown>()
        yCell.set("history", new Y.Array<CellHistoryEntry>())
        yCell.set("translatedXml", new Y.XmlFragment())
        cellsMap.set(id, yCell)
      }
      // Replace the __source stash — serializeCell reads this as the canonical
      // on-disk shape, so merged edits become the new baseline.
      yCell.set("__source", JSON.parse(JSON.stringify(cell)))

      // Refresh the translatedXml fragment so the editor UI sees the merged
      // value. Without this the fragment retains our pre-merge HTML and
      // isCellDirty reports a false-positive on the next sync (fragment vs
      // __source.value diverge).
      let frag = yCell.get("translatedXml") as Y.XmlFragment | undefined
      if (!frag) {
        frag = new Y.XmlFragment()
        yCell.set("translatedXml", frag)
      }
      frag.delete(0, frag.length)
      if (cell.value) setFragmentFromHtml(frag, cell.value)

      // Replace unsynced history with a derived ledger so the UI's status
      // derivation (useCells → deriveStatus) reflects the merged validation
      // state instead of defaulting to "validated" when the array is empty.
      let hist = yCell.get("history") as Y.Array<CellHistoryEntry> | undefined
      if (!hist) {
        hist = new Y.Array<CellHistoryEntry>()
        yCell.set("history", hist)
      }
      if (hist.length > 0) hist.delete(0, hist.length)
      const historyEntries = mapEditHistory(cell.metadata.edits ?? [])
      for (const entry of historyEntries) hist.push([entry])

      yCell.set("__lastSyncedHistoryAt", syncedAt)
    }

    order.delete(0, order.length)
    for (const cell of merged.cells) order.push([cell.metadata.id])

    meta.set("__source", merged.metadata)
  })
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
        translated: extractCellTranslated(cell),
        translatedHtml: (() => {
          const frag = cell.get("translatedXml") as Y.XmlFragment | undefined
          return frag ? getFragmentHtml(frag) : undefined
        })(),
        context: (cell.get("context") as string) || "",
        group: (cell.get("group") as string) || "",
        type: (cell.get("type") as string) || "text",
        sourceLocation: cell.get("sourceLocation") as { file: string; blockPath: string } | undefined,
        backtranslation: cell.get("backtranslation") as string | undefined,
        backtranslationUpdatedAt: cell.get("backtranslationUpdatedAt") as string | undefined,
        backtranslationForText: cell.get("backtranslationForText") as string | undefined,
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
