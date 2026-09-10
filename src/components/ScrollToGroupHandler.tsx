// ── ScrollToGroupHandler ───────────────────────────────────────────────────
// Must render inside <EditorScrollProvider> so useEditorScroll() has context.
// Watches editorScroll.pending and turns the editor to the first matching cell
// via the forwarded editorRef.
//
// AQU-1244: this used to resolve the request to a row index counted over the
// WHOLE file and call scrollToCellIndex. With "Split into milestones" on, the
// editor only renders the current milestone's rows, so a whole-file index was
// either out of range (the request was silently dropped) or pointed at an
// unrelated row of the page already showing — and neither outcome changed the
// selected milestone. Resolving to a cell ID and going through scrollToCellId
// uses the editor's ID-based path, which turns to the milestone containing the
// target cell when it is not on the current page (the same path search,
// presence, and findings jumps use). Both callers of the request — the Files
// panel's chapter/section rows and the contextual-run pill's range chips — are
// fixed by this.

import { useEffect } from "react"
import { useEditorScroll } from "@/context/EditorScrollContext"
import type { CellStore } from "@/hooks/useActiveCellStore"
import type { EditorTableHandle } from "@/components/EditorTable"

interface ScrollToGroupHandlerProps {
  cellStore: CellStore
  storeVersion: number
  editorRef: React.RefObject<EditorTableHandle | null>
}

export function ScrollToGroupHandler({ cellStore, storeVersion, editorRef }: ScrollToGroupHandlerProps) {
  const editorScroll = useEditorScroll()

  useEffect(() => {
    void storeVersion
    const pending = editorScroll.pending
    if (!pending) return
    const { group: groupId, section: sectionLabel, fileId: targetFileId } = pending

    // FRO-250/254: only consume() when the active store belongs to the requested
    // file. During a file-switch the pending request may already carry the NEW
    // file's id while the store is still clearing/loading; consuming early would
    // jump nowhere and burn the request.
    const currentFileId = cellStore.getFileId()
    if (targetFileId !== null && currentFileId !== targetFileId) {
      // Leave the request pending until the store has been replaced.
      return
    }

    editorScroll.consume()
    if (!groupId && !sectionLabel) return

    let cellId: string | null = null
    if (sectionLabel) {
      cellId = cellStore.findCellIdBySection(sectionLabel)
    } else if (groupId) {
      cellId = cellStore.getAllSummaries()
        .find((cell) => (cell.group ?? "Ungrouped") === groupId)?.id ?? null
    }

    if (cellId) {
      const targetCellId = cellId
      // Defer a tick so the virtualized list has the latest cell list after any
      // file-switch that preceded this request.
      setTimeout(() => {
        editorRef.current?.scrollToCellId(targetCellId)
      }, 0)
    }
  }, [cellStore, editorScroll, editorRef, storeVersion])

  return null
}
