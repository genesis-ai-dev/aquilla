// Background seam classification for the open file (AQU-1386).
//
// Runs OFF the drafting hot path, by design: opening a file kicks one pass that
// classifies whatever seams are not already cached, and drafting later reads
// the cache synchronously (see src/lib/completion/seam-store.ts). Nothing waits
// on this — if it has not finished, or never ran, or failed, drafting groups on
// punctuation instead and the user sees no difference in latency.
//
// It does nothing at all while the meaning-unit flag is off, which it is until
// the shadow eval clears. A classification pass that no drafting path reads
// would be pure spend.

import { useEffect, useRef } from "react"
import type { CellData } from "./useCells"
import { effectiveSourceText } from "@/lib/cell-text"
import { ensureSeamsForFile, type SeamStoreCell } from "@/lib/completion/seam-store"
import { classifySeamWindow } from "@/lib/completion/seam-classify-client"
import { isMeaningUnitDraftingEnabled } from "@/lib/completion/seams-flag"

function toSeamCell(cell: CellData): SeamStoreCell {
  return {
    id: cell.id,
    fileId: cell.fileId,
    sourceEventId: cell.sourceEventId ?? null,
    text: effectiveSourceText(cell),
    ref: cell.cellLabel ?? null,
  }
}

export interface SeamClassificationOptions {
  projectId: string | undefined
  fileId: string | undefined
  identityToken: string | undefined
  /** Ordered cells of the open file. */
  getCells: () => CellData[]
}

/**
 * Classify the open file's seams once, in the background.
 *
 * Keyed on `fileId` so switching files starts a pass for the new one and
 * re-opening a file it has already run for is a no-op — `ensureSeamsForFile`
 * skips every window whose seams are cached, so the second visit costs nothing
 * even if this effect re-fires.
 */
export function useSeamClassification(options: SeamClassificationOptions): void {
  const { projectId, fileId, identityToken, getCells } = options
  // The callback's identity may change on every render of a large parent; a ref
  // keeps the classification effect keyed on the FILE, so a re-render cannot
  // restart a pass that is already under way. Updated in its own effect —
  // declared first, so it has already run when the effect below fires on mount
  // — rather than during render, which the refs lint rule rightly forbids.
  const getCellsRef = useRef(getCells)
  useEffect(() => {
    getCellsRef.current = getCells
  })

  useEffect(() => {
    if (!isMeaningUnitDraftingEnabled()) return
    if (!projectId || !fileId || !identityToken) return

    const controller = new AbortController()
    const cells = getCellsRef.current()
      .filter((c) => c.fileId === fileId)
      .map(toSeamCell)
      .filter((c) => c.text.trim() !== "")
    if (cells.length < 2) return

    void ensureSeamsForFile(cells, (window) =>
      classifySeamWindow(window, {
        identityToken,
        projectId,
        signal: controller.signal,
      }),
    )

    // Leaving the file aborts the in-flight window. Windows already written to
    // the cache stay — a partial pass is progress, and the next visit resumes
    // from where it stopped rather than restarting.
    return () => controller.abort()
  }, [projectId, fileId, identityToken])
}
