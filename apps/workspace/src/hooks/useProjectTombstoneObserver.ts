// Observes the sync-worker-injected `projectDeletedAt` field on a file's
// Y.Doc `meta` map. When the server archives a project, the DO writes that
// field into the doc's meta map; partyserver broadcasts the update to every
// connected client. This hook reads that signal and reconciles local IDB
// so the TrashedProjectScreen appears immediately.

import { useEffect } from "react"
import * as Y from "yjs"
import { patchProject } from "@/lib/store/project-index"

export function useProjectTombstoneObserver(
  doc: Y.Doc | null,
  projectId: string | null,
  onDetected: () => void
): void {
  useEffect(() => {
    if (!doc || !projectId) return
    const meta = doc.getMap("meta")

    async function applyFromMeta() {
      const deletedAt = meta.get("projectDeletedAt") as string | null | undefined
      const deletedBy = meta.get("projectDeletedBy") as string | null | undefined
      if (deletedAt) {
        const updated = await patchProject(projectId!, (p) => {
          if (p.deletedAt === deletedAt) return p
          return { ...p, deletedAt, deletedBy: deletedBy ?? p.deletedBy }
        })
        if (updated) onDetected()
      } else {
        // Meta cleared → project was unarchived upstream. Drop the local tombstone
        // so the editor becomes reachable again. Only rewrite if it was set.
        const updated = await patchProject(projectId!, (p) => {
          if (!p.deletedAt) return p
          const next = { ...p }
          delete next.deletedAt
          delete next.deletedBy
          return next
        })
        if (updated) onDetected()
      }
    }

    // Apply once on mount in case the doc already carried the meta (e.g. cold
    // DO load replayed the archive marker into the doc before we subscribed).
    void applyFromMeta()

    const observer = () => { void applyFromMeta() }
    meta.observe(observer)
    return () => { meta.unobserve(observer) }
    // projectId and onDetected are stable enough that we intentionally skip
    // them; a change of projectId implies a new doc which triggers re-subscribe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, projectId])
}
