import { useEffect, useRef } from "react"
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
  const { activeTab, lastOpenTab, setActiveTab, selectVisibleTab } = dock

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
      selectVisibleTab("agent")
    } else if (activeTab === "agent") {
      selectVisibleTab(panelBeforeAgent.current)
    }
  }, [inAgentView, activeTab, lastOpenTab, selectVisibleTab])

  return dock
}
