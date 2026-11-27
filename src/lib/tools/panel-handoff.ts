/**
 * A side-panel request that has to outlive a route change.
 *
 * The builder page (/project/:id/extensions) and the workspace each mount
 * their own ToolsMountProvider, so `openInPanel()` called on the builder page
 * is gone by the time the editor renders. "Add to project" leaves the request
 * here and the next provider to mount for that project takes it.
 *
 * Held in memory on purpose: it is one hop inside the running app, and unlike
 * router state it cannot come back on a reload or on Back.
 */
let pending: { projectId: string; toolId: string } | null = null

export function requestPanelOnArrival(projectId: string, toolId: string): void {
  pending = { projectId, toolId }
}

/** The extension waiting to be opened for this project, cleared as it is read. */
export function takePanelRequest(projectId: string): string | null {
  if (pending?.projectId !== projectId) return null
  const { toolId } = pending
  pending = null
  return toolId
}
