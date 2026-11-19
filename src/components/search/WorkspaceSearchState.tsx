import type { ReactNode } from "react"
import {
  useWorkspaceSearchState,
  type WorkspaceSearchSnapshot,
  type WorkspaceSearchStore,
} from "@/hooks/useWorkspaceSearch"

/**
 * Subscribes ITS CHILDREN to the workspace's search state (AQU-2654).
 *
 * The workspace owns the search (it knows the project, the token and where a
 * hit should jump to) but must not re-render for it: results arriving redraw
 * this component and what it wraps — the dock panel, the expanded results, the
 * Find & Replace dialog — and nothing else.
 */
export function WorkspaceSearchState({
  store,
  children,
}: {
  store: WorkspaceSearchStore
  children: (state: WorkspaceSearchSnapshot) => ReactNode
}) {
  return children(useWorkspaceSearchState(store))
}
