import { parseOrgPath } from "@/lib/navigation/org-paths"

/**
 * Routes where switching the active org should navigate (not only update
 * localStorage). Org-shell paths always qualify; flat project/overview paths
 * still force a leave-to-org-home so you don't keep editing a project after
 * the chrome says you switched orgs.
 */
export function isOrgScopedRoute(pathname: string): boolean {
  if (parseOrgPath(pathname) != null) return true
  if (pathname === "/project" || pathname.startsWith("/project/")) return true
  if (pathname === "/projects" || pathname.startsWith("/projects/")) return true
  return false
}
