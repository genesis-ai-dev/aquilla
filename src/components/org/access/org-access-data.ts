/**
 * AQU-1352 §3.6 (AQU-1072): wire shape + read + CSV for the org "People &
 * access" page, GET /api/v2/orgs/:orgId/access (auth-worker/src/routes/org-access.ts).
 * The server already dropped every grant the viewer may not see (§3.8 rule 4).
 */
import { FRONTIER_API_URL } from "@/lib/sync/sync-token"
import { UserError } from "@/lib/errors/user-error"
import { formatScopePath } from "@/lib/access/scope-path"
import type { AccessChainEntry, ScopeRef } from "@/lib/access/types"
import type { TFunction } from "@/lib/i18n/I18nProvider"
import { originLabel, roleLabel } from "@/components/access/labels"

export interface DirectGrantee { userId: string; displayName: string; roleLevel: number }
export interface AccessTreeNode { scope: ScopeRef; children: AccessTreeNode[]; directGrantees: DirectGrantee[] }
export interface OrgAccessPerson { userId: string; displayName: string; isGuest: boolean; grants: AccessChainEntry[] }
export interface OrgAccessPayload { tree: AccessTreeNode[]; people: OrgAccessPerson[] }

export async function fetchOrgAccess(jwt: string, orgId: number, apiUrl: string = FRONTIER_API_URL): Promise<OrgAccessPayload> {
  const res = await fetch(`${apiUrl}/api/v2/orgs/${orgId}/access`, { headers: { Authorization: `Bearer ${jwt}` } })
  if (!res.ok) throw new UserError(res.status, await res.text().catch(() => ""), "project")
  return (await res.json()) as OrgAccessPayload
}

const csvCell = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)

/** One row per (person, grant). Scope column is formatScopePath — the same
 *  bytes the chips and breadcrumbs render (spec §3.9). */
export function orgAccessCsv(t: TFunction, people: OrgAccessPerson[]): string {
  const header = [
    t("org.access.page.csvPerson"),
    t("dialog.assign.scopeLabel"),
    t("common.roleLabel"),
    t("org.access.page.csvOrigin"),
    t("org.access.page.csvGrantedBy"),
    t("org.access.page.csvGrantedAt"),
  ]
  const rows = people.flatMap((p) =>
    p.grants.map((g) => [
      p.displayName,
      formatScopePath(g.scopePath),
      roleLabel(t, g.roleLevel),
      originLabel(t, g.origin),
      g.grantedBy ?? "",
      g.grantedAt ?? "",
    ]),
  )
  return [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n"
}
