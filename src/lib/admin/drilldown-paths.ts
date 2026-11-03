/**
 * Admin console deep links. The console keeps its view in the query string, so
 * these double as the URL scheme: `?tab=tenants&org=<id>` is one org's page,
 * `?tab=people&user=<id>` is one person's page.
 */
export function adminOrgHref(orgId: number): string {
  return `/admin?tab=tenants&org=${orgId}`
}

export function adminUserHref(userId: number): string {
  return `/admin?tab=people&user=${userId}`
}
