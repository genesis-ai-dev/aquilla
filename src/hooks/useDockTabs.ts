import { useCallback, useState, type SetStateAction } from "react"

export type DockTab = "files" | "agent" | "search" | "voices"

/** Keep panel visibility separate from the last selected panel. */
export function useDockTabs(initialTab: DockTab = "files") {
  const [state, setState] = useState<{
    activeTab: DockTab | null
    lastOpenTab: DockTab
  }>(() => ({ activeTab: initialTab, lastOpenTab: initialTab }))

  const setActiveTab = useCallback((update: SetStateAction<DockTab | null>) => {
    setState((current) => {
      const activeTab = typeof update === "function" ? update(current.activeTab) : update
      if (activeTab === current.activeTab) return current
      return { activeTab, lastOpenTab: activeTab ?? current.lastOpenTab }
    })
  }, [])

  const selectVisibleTab = useCallback((tab: DockTab) => {
    setState((current) => {
      if (current.activeTab === null || current.activeTab === tab) return current
      return { activeTab: tab, lastOpenTab: tab }
    })
  }, [])

  return { ...state, setActiveTab, selectVisibleTab }
}
