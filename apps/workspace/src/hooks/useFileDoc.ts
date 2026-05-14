// Phase 2b: useFileDoc is a shim around a fresh in-memory Y.Doc.
//
// Pre-Phase 2b this hook loaded a per-file Y.Doc out of IndexedDB
// (via `loadFileDoc` / `y-indexeddb`) and bound it to the TipTap editor.
// Phase 2b pulls cells reads onto the sync-worker projection (D1), but the
// TipTap editor still wants a Y.XmlFragment per cell for collaboration —
// that wiring is unwound in Phase 2c. So in the meantime we hand the editor
// an *empty, unpersisted* Y.Doc keyed to the current fileId. It satisfies
// the type contract; the editor's collaboration extension binds to it
// happily; the doc has no cells in it so the editor falls back to whatever
// initial state CellRow / TranslatedEditor seeds.
//
// Phase 2c rips this shim out along with the rest of Y.Doc: it deletes
// `@tiptap/extension-collaboration`, rewrites the cell editor to write
// directly to the outbox, and removes this file.
//
// Consequences during Phase 2b:
// - No IDB persistence — refreshing the page loses any in-memory Y.Doc
//   state. Reads through useCells still hit the server projection, so the
//   UI reloads the canonical text. Writes through the legacy Y.Doc path
//   are lost; Phase 2c is the only durable write path.
// - No R2 sync — peers don't see your draft edits in real time.
// - The render-time guard that prevents "text bleeding across files" is
//   preserved by allocating a *new* Y.Doc per fileId; switching files
//   replaces the doc handle just like the old version replaced the IDB-
//   backed handle.

import { useEffect, useRef, useState } from "react"
import * as Y from "yjs"

interface DocSlot {
  fileId: string
  doc: Y.Doc | null
}

export function useFileDoc(fileId: string | null): { doc: Y.Doc | null; loading: boolean } {
  const [slot, setSlot] = useState<DocSlot>({ fileId: fileId ?? "", doc: null })
  const destroyedRef = useRef<Y.Doc | null>(null)

  // Drop the previous doc the moment fileId changes — before the new effect
  // runs. Same render-time guard as the pre-Phase 2b version: prevents one
  // frame where `fileId` already points at file B but `doc` still points at
  // file A.
  if (slot.fileId !== (fileId ?? "")) {
    if (slot.doc) destroyedRef.current = slot.doc
    setSlot({ fileId: fileId ?? "", doc: null })
  }

  useEffect(() => {
    if (!fileId) return
    // Allocate a fresh Y.Doc for this fileId. Empty, no persistence.
    const doc = new Y.Doc()
    setSlot({ fileId, doc })
    return () => {
      // Y.Docs are cheap to destroy; clearing the slot avoids dangling
      // observers in StrictMode dry-runs.
      doc.destroy()
    }
  }, [fileId])

  // Clean up the previous doc if we transitioned. We can't put destroy()
  // inside the setSlot call above because Y.Doc.destroy() has side effects
  // and React forbids side effects during render.
  useEffect(() => {
    if (destroyedRef.current) {
      destroyedRef.current.destroy()
      destroyedRef.current = null
    }
  })

  const matched = slot.fileId === (fileId ?? "") ? slot.doc : null
  return { doc: matched, loading: fileId !== null && matched === null }
}
