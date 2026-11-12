import { Navigate, useLocation, useParams } from "react-router-dom"
import { projectOverviewPath } from "@/lib/navigation/org-paths"

/**
 * AQU-1535: a bare `/project/:id` used to fall through to the 404 catch-all.
 * That is the path the changeset approval page's "Back to {project}" link
 * points at, and the one anyone typing or sharing a project URL guesses — so
 * land them on the project overview (`/projects/:id`) instead of Page not
 * found. Query string and hash ride along; the entry is replaced so the dead
 * URL stays out of the history stack.
 */
export function RedirectToProjectOverview() {
  const { id } = useParams<{ id: string }>()
  const { search, hash } = useLocation()
  if (!id) return <Navigate to="/" replace />
  return <Navigate to={`${projectOverviewPath(id)}${search}${hash}`} replace />
}
