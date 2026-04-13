import { useCallback, useEffect, useState } from "react"
import type { ProjectRecord } from "@/lib/parsers/types"
import { getProject } from "@/lib/store/project-index"

export function useProject(projectId: string) {
  const [project, setProject] = useState<ProjectRecord | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(() => {
    setLoading(true)
    getProject(projectId).then((p) => {
      setProject(p || null)
      setLoading(false)
    })
  }, [projectId])

  useEffect(() => {
    refresh()
  }, [refresh])

  return { project, loading, refresh }
}
