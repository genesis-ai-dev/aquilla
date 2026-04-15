import * as Y from "yjs"
import type { CodexCell } from "@/lib/codex-editor/types"
import type { CellHistoryEntry, ProjectRecord } from "@/lib/parsers/types"
import { getFragmentHtml } from "@/lib/richtext/translated-xml"
import { loadFileDoc, destroyFileDoc } from "@/lib/store/file-doc"

export function isCellDirty(cell: Y.Map<unknown>): boolean {
  const source = cell.get("__source") as CodexCell | undefined
  if (!source) return true // new cell — treat as dirty (Phase 2 doesn't add cells but defensive)

  const frag = cell.get("translatedXml") as Y.XmlFragment | undefined
  const currentValue = frag ? getFragmentHtml(frag) : ""
  if (currentValue !== source.value) return true

  const lastSynced = (cell.get("__lastSyncedHistoryAt") as number) ?? 0
  const histArr = cell.get("history") as Y.Array<CellHistoryEntry> | undefined
  if (histArr) {
    for (const e of histArr.toArray()) {
      if (Date.parse(e.timestamp) > lastSynced) return true
    }
  }
  return false
}

export function isFileDirty(doc: Y.Doc): boolean {
  const cellsMap = doc.getMap("cells")
  for (const id of cellsMap.keys()) {
    const c = cellsMap.get(id) as Y.Map<unknown> | undefined
    if (c && isCellDirty(c)) return true
  }
  return false
}

export async function isProjectDirty(project: ProjectRecord): Promise<boolean> {
  for (const f of project.files) {
    const handle = loadFileDoc(f.id)
    try {
      await new Promise<void>((r) => {
        if (handle.persistence.synced) r()
        else handle.persistence.once("synced", () => r())
      })
      if (isFileDirty(handle.doc)) return true
    } finally {
      destroyFileDoc(handle)
    }
  }
  return false
}
