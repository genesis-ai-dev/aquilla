import { useCallback, useEffect, useRef, useState } from "react"
import type { ProjectRecord } from "@/lib/parsers/types"
import { getProject } from "@/lib/store/project-index"

export function useProject(projectId: string) {
  const [project, setProject] = useState<ProjectRecord | null>(null)
  const [loading, setLoading] = useState(true)
  const hasLoaded = useRef(false)

  const refresh = useCallback(() => {
    // Only show the loading state on the first fetch. Subsequent refreshes
    // (e.g. after sync) keep the stale project visible so the editor doesn't
    // unmount — which would reset scroll position and Y.Doc bindings.
    if (!hasLoaded.current) setLoading(true)
    getProject(projectId).then((p) => {
      setProject(p || null)
      hasLoaded.current = true
      setLoading(false)
    })
  }, [projectId])

  useEffect(() => {
    refresh()
  }, [refresh])

  return { project, loading, refresh }
}
