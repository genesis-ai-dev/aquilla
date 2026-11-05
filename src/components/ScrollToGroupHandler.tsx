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

    // FRO-250/254 → AQU-1244 → AQU-1442: only consume() once the store holds
    // THE REQUESTED FILE'S OWN ROWS. Three distinct states have to be waited
    // out on a cross-file click, and the first two rounds of this guard each
    // covered only one of them:
    //
    //   1. the runtime file id is still the outgoing file (the request arrived
    //      before the switch reached the store) — `getFileId()` catches it;
    //   2. the runtime file id is the incoming file and the store is empty
    //      (reset done, fetch in flight) — the cell count caught it;
    //   3. the runtime file id is the incoming file while `order` STILL HOLDS
    //      the outgoing file's rows. `setRuntime` flips `ctx.fileId` and only
    //      re-partitions the loaded rows against the lane; nothing is cleared
    //      until `reset()`. Both ids match and the count is non-zero, so the
    //      first two checks pass and the handler consumes — resolving the
    //      section against the OUTGOING file's navigation index.
    //
    // State 3 is the one that keeps burning requests, because a canonical
    // section key is file-independent: "Genesis 2" is `scripture:GEN:2` in both
    // files, so the lookup does not fail loudly — it returns a real, wrong cell
    // id belonging to the file being navigated away from. `scrollToCellId`
    // cannot find that id among the incoming file's rows, nothing moves, and the
    // request is gone, leaving the new file on its first milestone.
    //
    // `getLoadedRowsFileId()` is the rows' own provenance rather than the file
    // the store is pointed at, so one check now rules out all three states; it
    // is null while no rows are loaded, which subsumes the count check for a
    // file-stamped request. This effect re-runs as the store version advances,
    // so the parked request is picked up as soon as the rows land.
    if (targetFileId !== null && cellStore.getLoadedRowsFileId() !== targetFileId) {
      // Leave the request pending until the requested file's rows are in.
      return
    }

    // A request with no file stamp (an older caller) can still only be resolved
    // against rows that exist.
    if (cellStore.getCellCount() === 0) return

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
