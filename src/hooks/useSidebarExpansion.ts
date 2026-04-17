import { useCallback, useEffect, useState } from "react"

function storageKey(projectId: string) {
  return `sidebar:expanded:${projectId}`
}

function read(projectId: string): Set<string> {
  try {
    const raw = localStorage.getItem(storageKey(projectId))
    if (!raw) return new Set()
    const arr = JSON.parse(raw) as unknown
    if (!Array.isArray(arr)) return new Set()
    return new Set(arr.filter((x): x is string => typeof x === "string"))
  } catch {
    return new Set()
  }
}

export function useSidebarExpansion(projectId: string) {
  const [expanded, setExpanded] = useState<Set<string>>(() => read(projectId))

  useEffect(() => { setExpanded(read(projectId)) }, [projectId])

  const toggle = useCallback((fileId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(fileId)) next.delete(fileId)
      else next.add(fileId)
      try {
        localStorage.setItem(storageKey(projectId), JSON.stringify(Array.from(next)))
      } catch { /* ignore quota errors */ }
      return next
    })
  }, [projectId])

  return { expanded, toggle }
}
