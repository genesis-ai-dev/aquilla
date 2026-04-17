import { useEffect, useRef } from "react"
import type { ProjectRecord } from "@/lib/parsers/types"
import { updateProject } from "@/lib/store/project-index"
import { loadFileDoc, destroyFileDoc } from "@/lib/store/file-doc"
import { getTestament } from "@/lib/codex-editor/bible-books"

export function useCorpusBackfill(project: ProjectRecord | null, onUpdated: () => void) {
  const ranFor = useRef<string | null>(null)

  useEffect(() => {
    if (!project) return
    if (ranFor.current === project.id) return
    ranFor.current = project.id

    const missing = project.files.filter((f) => !f.corpusMarker)
    if (missing.length === 0) return

    let cancelled = false
    ;(async () => {
      const updates: Record<string, string> = {}
      for (const file of missing) {
        const handle = loadFileDoc(file.id)
        try {
          await new Promise<void>((resolve) => {
            if (handle.persistence.synced) resolve()
            else handle.persistence.once("synced", () => resolve())
          })
          if (cancelled) return
          const meta = handle.doc.getMap("meta").get("__source") as { corpusMarker?: string } | undefined
          const marker = meta?.corpusMarker || getTestament(file.name)
          if (marker) updates[file.id] = marker
        } finally {
          destroyFileDoc(handle)
        }
      }
      if (cancelled || Object.keys(updates).length === 0) return
      const updatedFiles = project.files.map((f) =>
        updates[f.id] ? { ...f, corpusMarker: updates[f.id] } : f
      )
      await updateProject({ ...project, files: updatedFiles })
      if (!cancelled) onUpdated()
    })()

    return () => { cancelled = true }
  }, [project, onUpdated])
}
