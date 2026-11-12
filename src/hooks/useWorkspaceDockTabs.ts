import { useCallback, useEffect, useRef, type SetStateAction } from "react"
import { readLastDockTab, writeLastDockTab } from "@/lib/dock-tab"
import { useDockTabs, type DockTab } from "./useDockTabs"

/**
 * Navigation may choose a visible panel, but must not undo a user's collapse.
 *
 * FRO-308: with a `projectId`, the last real tab is restored from localStorage
 * per project so a reload returns to Files / Voices / Agent / Search instead of
 * always landing on Files. Collapsed (`null`) is never stored.
 */
export function useWorkspaceDockTabs(inAgentView: boolean, projectId?: string) {
  const dock = useDockTabs(
    inAgentView ? "agent" : projectId ? readLastDockTab(projectId) : "files",
  )
  const previousAgentView = useRef(inAgentView)
  const panelBeforeAgent = useRef<DockTab>("files")
  const previousProjectId = useRef(projectId)
  // A switch the app made for the user mid-takeover (the workbench's "Choose
  // file" picker) is not a manual pick: leaving Agent still restores the saved
  // panel. A manual pick clears it.
  const switchedProgrammatically = useRef(false)
  const { activeTab, lastOpenTab, setActiveTab: setDockTab, selectVisibleTab } = dock

  const setActiveTab = useCallback((update: SetStateAction<DockTab | null>) => {
    switchedProgrammatically.current = false
    setDockTab(update)
  }, [setDockTab])

  const showProgrammatically = useCallback((tab: DockTab) => {
    switchedProgrammatically.current = true
    setDockTab(tab)
  }, [setDockTab])

  useEffect(() => {
    if (previousProjectId.current === projectId) return
    previousProjectId.current = projectId
    if (projectId) setActiveTab(readLastDockTab(projectId))
  }, [projectId, setActiveTab])

  useEffect(() => {
    if (projectId) writeLastDockTab(projectId, lastOpenTab)
  }, [projectId, lastOpenTab])

  useEffect(() => {
    if (previousAgentView.current === inAgentView) return
    previousAgentView.current = inAgentView
    if (inAgentView) {
      panelBeforeAgent.current = lastOpenTab
      switchedProgrammatically.current = false
      selectVisibleTab("agent")
    } else if (activeTab === "agent" || switchedProgrammatically.current) {
      switchedProgrammatically.current = false
      selectVisibleTab(panelBeforeAgent.current)
    }
  }, [inAgentView, activeTab, lastOpenTab, selectVisibleTab])

  return { ...dock, setActiveTab, showProgrammatically }
}
