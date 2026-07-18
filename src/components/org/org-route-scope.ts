const ORG_SCOPED_ROUTE_PREFIXES = [
  "/assigned",
  "/members",
  // AQU-370: the project workspace/editor (`/project/:id`, `/project/:id/file/…`,
  // settings, etc.) belongs to exactly one org, so switching org — or picking
  // "All organizations" — from inside it must navigate to the new org's
  // overview, not silently swap the org context while leaving you on a stale
  // project route. This prefix is distinct from the plural `/projects` (the
  // org-level project list) below; neither substring-matches the other.
  "/project",
  "/projects",
  "/settings",
  "/teams",
]

export function isOrgScopedRoute(pathname: string): boolean {
  return ORG_SCOPED_ROUTE_PREFIXES.some((prefix) => (
    pathname === prefix || pathname.startsWith(`${prefix}/`)
  ))
}
