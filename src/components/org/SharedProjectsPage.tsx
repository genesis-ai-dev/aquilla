import { Navigate, useSearchParams } from "react-router-dom"
import { orgHomePath } from "@/lib/navigation/org-paths"

/**
 * `/shared` used to be the dedicated home for foreign-org grants (AQU-417).
 * Those rows now live on `/orgs/all` (same projects table, Shared origin).
 * Guest orgs keep `/orgs/:id`. Keep this route so old bookmarks still resolve.
 */
export function SharedProjectsPage() {
  const [searchParams] = useSearchParams()
  const scopedOrgParam = searchParams.get("org")
  const scopedOrgId =
    scopedOrgParam != null && Number.isFinite(Number(scopedOrgParam))
      ? Number(scopedOrgParam)
      : null
  if (scopedOrgId != null) {
    return <Navigate to={orgHomePath(scopedOrgId)} replace />
  }
  return <Navigate to="/orgs/all" replace />
}
