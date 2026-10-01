import type { ReactNode } from "react"
import { Navigate, useLocation, useParams } from "react-router-dom"
import { useIsLgUp } from "@/hooks/useIsLgUp"
import { editorReturnFromLocation } from "@/lib/navigation/org-paths"

/**
 * Route element for **every** `/project/:id/...` workspace surface.
 *
 * It has to sit on all of them, not just `/agent`. `<Routes>` renders its match
 * into one child slot, so React reconciles surface hops by element *type* at
 * that slot. AQU-806 wrapped the agent route alone, which made the type change
 * on an editor → agent hop: React unmounted `ProjectWorkspace` and mounted a
 * fresh one. The open file lives in that component's state and the agent URL
 * carries no file in its path, so the rebuilt workspace had no file and the
 * workbench showed "Choose a file" (AQU-1496). Wrapping every surface keeps the
 * type — and therefore the instance and its open file — stable across the hop.
 *
 * The AQU-806 guard itself still stands: the three-pane workbench must not
 * mount on a compact viewport, so the agent surface alone redirects back to the
 * editor there.
 */
export function ProjectWorkspaceRoute({ children }: { children: ReactNode }) {
  const desktop = useIsLgUp()
  const { id } = useParams()
  const location = useLocation()

  // Same path test `ProjectWorkspace` uses to derive its center surface.
  const compactAgent = !desktop && location.pathname.endsWith("/agent")
  if (!compactAgent) return <>{children}</>
  if (!id) return <Navigate to="/orgs/all" replace />

  const editorPath = editorReturnFromLocation(location.pathname, location.search, id)
    ?? `/project/${id}/editor`
  return <Navigate to={editorPath} replace />
}
