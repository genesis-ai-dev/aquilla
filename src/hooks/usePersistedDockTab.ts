import { useCallback, useEffect, useRef, useState, type SetStateAction } from "react"
import { readLastDockTab, writeLastDockTab, type DockTab } from "@/lib/dock-tab"

/**
 * Left-dock tab with per-project localStorage restore.
 *
 * `null` is the in-session collapsed rail and is not persisted — the last real
 * tab stays in storage so a reload (or expand) reopens it.
 */
export function usePersistedDockTab(
  projectId: string | undefined,
): [DockTab | null, (next: SetStateAction<DockTab | null>) => void] {
  const [dockTab, setDockTabState] = useState<DockTab | null>(() =>
    projectId ? readLastDockTab(projectId) : "files",
  )
  const projectIdRef = useRef(projectId)
  projectIdRef.current = projectId

  useEffect(() => {
    setDockTabState(projectId ? readLastDockTab(projectId) : "files")
  }, [projectId])

  const setDockTab = useCallback((next: SetStateAction<DockTab | null>) => {
    setDockTabState((prev) => {
      const resolved = typeof next === "function" ? next(prev) : next
      const id = projectIdRef.current
      if (id && resolved) writeLastDockTab(id, resolved)
      return resolved
    })
  }, [])

  return [dockTab, setDockTab]
}
