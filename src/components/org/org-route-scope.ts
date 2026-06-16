const ORG_SCOPED_ROUTE_PREFIXES = [
  "/assigned",
  "/members",
  "/projects/archived",
  "/settings",
  "/teams",
]

export function isOrgScopedRoute(pathname: string): boolean {
  return ORG_SCOPED_ROUTE_PREFIXES.some((prefix) => (
    pathname === prefix || pathname.startsWith(`${prefix}/`)
  ))
}
