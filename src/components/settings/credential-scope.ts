// Scope naming for an API credential, shared by the tokens list and the
// dialogs that describe a token to its user. Kept out of the component files
// so neither has to export a non-component.

import type { useT } from "@/lib/i18n/I18nProvider"
import type { OrgSummary } from "@/lib/frontier/orgs"
import type { CloudProjectSummary } from "@/lib/sync/cloud-projects"
import type { ApiCredential } from "@/lib/sync/credentials"

/** Resolve a credential's org/project scope into a friendly label. Falls back
 * to the raw id when the org/project isn't in the caller's current lists
 * (e.g. access was later revoked). */
export function scopeLabel(
  t: ReturnType<typeof useT>,
  cred: ApiCredential,
  orgs: OrgSummary[],
  projects: CloudProjectSummary[],
): string {
  if (cred.projectId) {
    const p = projects.find((p) => p.id === cred.projectId)
    return p ? p.name : t("onboarding.apiTokens.scope.projectFallback", { id: cred.projectId })
  }
  if (cred.orgId) {
    const o = orgs.find((o) => String(o.id) === cred.orgId)
    return o ? (o.name ?? t("onboarding.apiTokens.scope.orgFallback", { id: o.id })) : t("onboarding.apiTokens.scope.orgFallback", { id: cred.orgId })
  }
  return t("onboarding.apiTokens.scope.unscoped")
}
