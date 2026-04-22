import { useEffect, useRef } from "react"
import type { ProjectRecord } from "@/lib/parsers/types"
import { patchProject } from "@/lib/store/project-index"
import { getTestament } from "@/lib/codex-editor/bible-books"

export function useCorpusBackfill(project: ProjectRecord | null, onUpdated: () => void) {
  const ranFor = useRef<string | null>(null)

  useEffect(() => {
    if (!project) return
    if (ranFor.current === project.id) return
    ranFor.current = project.id

    const missing = project.files.filter((f) => !f.corpusMarker)
    if (missing.length === 0) return

    // Filename-based detection only. The importer computes corpusMarker from
    // the same getTestament(stem) at import time (git-importer.ts), so any
    // unresolved files here would not have been resolvable via doc meta either
    // in the common case. Legacy imports with meta.__source.corpusMarker but
    // missing FileReference.corpusMarker can be fixed manually via the sidebar.
    const updates: Record<string, string> = {}
    for (const file of missing) {
      const marker = getTestament(file.name)
      if (marker) updates[file.id] = marker
    }
    if (Object.keys(updates).length === 0) return

    let cancelled = false
    ;(async () => {
      // patchProject reads the latest record from IDB before applying,
      // so we never clobber concurrent writes (e.g. completionSettings).
      await patchProject(project.id, (p) => ({
        ...p,
        files: p.files.map((f) =>
          updates[f.id] ? { ...f, corpusMarker: updates[f.id] } : f
        ),
      }))
      if (!cancelled) onUpdated()
    })()

    return () => { cancelled = true }
  }, [project, onUpdated])
}
