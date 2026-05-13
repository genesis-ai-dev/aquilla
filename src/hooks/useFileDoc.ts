import { useEffect, useState } from "react"
import * as Y from "yjs"
import { loadFileDoc, destroyFileDoc } from "@/lib/store/file-doc"

interface DocSlot {
  fileId: string
  doc: Y.Doc | null
}

/**
 * Bind a Y.Doc to the current fileId.
 *
 * Returns `doc=null` until the persistence layer has caught up for THIS exact
 * fileId. The render-time guard (`slot.fileId !== fileId`) is critical: without
 * it, the consumer renders one frame where `fileId` already points at file B
 * but `doc` is still file A's. That frame is what produces the "text bleeding
 * across files" symptom (#28) — useCells reads cells from doc A while every
 * other prop says B, and TipTap binds the row to a fragment that's about to be
 * destroyed.
 */
export function useFileDoc(fileId: string | null): { doc: Y.Doc | null; loading: boolean } {
  const [slot, setSlot] = useState<DocSlot>({ fileId: fileId ?? "", doc: null })

  // Drop the previous doc the moment fileId changes — before the new effect
  // even runs. This forces a re-render with doc=null so stale cells never
  // reach the editor.
  if (slot.fileId !== (fileId ?? "")) {
    setSlot({ fileId: fileId ?? "", doc: null })
  }

  useEffect(() => {
    if (!fileId) return
    const handle = loadFileDoc(fileId)
    const commit = () => setSlot({ fileId, doc: handle.doc })
    if (handle.persistence.synced) commit()
    else handle.persistence.once("synced", commit)
    return () => destroyFileDoc(handle)
  }, [fileId])

  const matched = slot.fileId === (fileId ?? "") ? slot.doc : null
  return { doc: matched, loading: fileId !== null && matched === null }
}
