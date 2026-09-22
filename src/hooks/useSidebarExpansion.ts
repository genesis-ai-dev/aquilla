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

function sameMembers(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false
  for (const id of a) if (!b.has(id)) return false
  return true
}

export function usePersistedToggleSet(storageKey: string) {
  const [members, setMembers] = useState<Set<string>>(() => read(storageKey))
  // AQU-350: returning a new Set identity for unchanged contents re-fires every
  // effect that depends on this set — in the Files sidebar that runs the
  // per-file progress prefetch sweep a second time on each mount.
  useEffect(() => {
    setMembers((prev) => {
      const next = read(storageKey)
      return sameMembers(prev, next) ? prev : next
    })
  }, [storageKey])

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
