import type { ReactNode } from "react"
import { Navigate, useLocation, useParams } from "react-router-dom"
import { useIsLgUp } from "@/hooks/useIsLgUp"
import { editorReturnFromLocation } from "@/lib/navigation/org-paths"

/** Do not mount the three-pane workbench on a compact viewport. */
export function AgentModeRoute({ children }: { children: ReactNode }) {
  const desktop = useIsLgUp()
  const { id } = useParams()
  const location = useLocation()

  if (desktop) return <>{children}</>
  if (!id) return <Navigate to="/orgs/all" replace />

  const editorPath = editorReturnFromLocation(location.pathname, location.search, id)
    ?? `/project/${id}/editor`
  return <Navigate to={editorPath} replace />
}
