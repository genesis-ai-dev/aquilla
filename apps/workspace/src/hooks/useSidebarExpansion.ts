import { useCallback, useEffect, useState } from "react"

/** Persisted toggle set keyed by (storageKey, scope). Used by the sidebar for
 *  per-file expansion AND per-corpus collapse — both share the same shape
 *  (a Set<string> backed by localStorage). */
function read(key: string): Set<string> {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return new Set()
    const arr = JSON.parse(raw) as unknown
    if (!Array.isArray(arr)) return new Set()
    return new Set(arr.filter((x): x is string => typeof x === "string"))
  } catch {
    return new Set()
  }
}

export function usePersistedToggleSet(storageKey: string) {
  const [members, setMembers] = useState<Set<string>>(() => read(storageKey))
  useEffect(() => { setMembers(read(storageKey)) }, [storageKey])

  const toggle = useCallback((id: string) => {
    setMembers((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      try { localStorage.setItem(storageKey, JSON.stringify([...next])) }
      catch { /* quota — non-fatal */ }
      return next
    })
  }, [storageKey])

  return { members, toggle }
}

export function useSidebarExpansion(projectId: string) {
  const { members, toggle } = usePersistedToggleSet(`sidebar:expanded:${projectId}`)
  return { expanded: members, toggle }
}
