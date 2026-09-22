import { useEffect, useRef } from "react"
import { useDockTabs, type DockTab } from "./useDockTabs"

/** Navigation may choose a visible panel, but must not undo a user's collapse. */
export function useWorkspaceDockTabs(inAgentView: boolean) {
  const dock = useDockTabs(inAgentView ? "agent" : "files")
  const previousAgentView = useRef(inAgentView)
  const panelBeforeAgent = useRef<DockTab>("files")
  const { activeTab, lastOpenTab, selectVisibleTab } = dock

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
