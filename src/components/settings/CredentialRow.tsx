// One row of the personal API tokens list (see ApiTokensSection.tsx), plus the
// scope-label helper the surrounding dialogs share.
//
// Extracted from ApiTokensSection so the scope/date presentation has one home:
// a token's blast radius (which org or project, which mode, whether it can write
// at all) has to be legible at a glance, which is display logic with its own
// rules, not list plumbing.

import { Building2, Eye, Folder, Globe, Pencil } from "lucide-react"
import { useI18n, useT } from "@/lib/i18n/I18nProvider"
import { fmtShortCalendarDate } from "@/lib/format-date"
import { DateTooltip } from "@/components/ui/date-tooltip"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import type { OrgSummary } from "@/lib/frontier/orgs"
import type { CloudProjectSummary } from "@/lib/sync/cloud-projects"
import type { ApiCredential } from "@/lib/sync/credentials"
import { scopeLabel } from "./credential-scope"

/** The scope chip: an icon for the KIND of reach (whole org / one project /
 * unscoped) beside the name, so the widest-reaching tokens are the ones that
 * stand out in a long list. */
function ScopeChip({
  credential,
  orgs,
  projects,
}: {
  credential: ApiCredential
  orgs: OrgSummary[]
  projects: CloudProjectSummary[]
}) {
  const t = useT()
  const name = scopeLabel(t, credential, orgs, projects)
  const { Icon, label } = credential.projectId
    ? { Icon: Folder, label: t("onboarding.apiTokens.scope.projectBadge", { name }) }
    : credential.orgId
      ? { Icon: Building2, label: t("onboarding.apiTokens.scope.orgBadge", { name }) }
      : { Icon: Globe, label: name }
  return (
    <Badge variant="outline" className="max-w-full gap-1 font-normal">
      <Icon className="size-3 shrink-0" aria-hidden />
      <span className="truncate">{label}</span>
    </Badge>
  )
}

export function CredentialRow({
  credential,
  orgs,
  projects,
  onRevoke,
  onShowInstructions,
}: {
  credential: ApiCredential
  orgs: OrgSummary[]
  projects: CloudProjectSummary[]
  onRevoke: () => void
  onShowInstructions: () => void
}) {
  const t = useT()
  const { locale } = useI18n()
  const revoked = Boolean(credential.revokedAt)
  const expired =
    !revoked && Boolean(credential.expiresAt) && new Date(credential.expiresAt!).getTime() < Date.now()
  const ModeIcon = credential.mode === "act" ? Pencil : Eye
  // AQU-1242: on a read-only token the mode badge would be a lie by omission —
  // `mode` is never consulted, so showing "ask" suggests writes are merely
  // gated rather than impossible. One badge, the true one.
  const readOnly = credential.access === "read"

  return (
    <li className="flex items-start justify-between gap-3 rounded-xl border px-3 py-2.5">
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <code className="text-xs font-mono">{credential.tokenPrefix}…</code>
          {readOnly ? (
            <Badge variant="outline" className="gap-1">
              <Eye className="size-3 shrink-0" aria-hidden />
              {t("onboarding.apiTokens.accessReadBadge")}
            </Badge>
          ) : (
            <Badge variant={credential.mode === "act" ? "default" : "secondary"} className="gap-1">
              <ModeIcon className="size-3 shrink-0" aria-hidden />
              {credential.mode}
            </Badge>
          )}
          {revoked && <Badge variant="destructive">{t("onboarding.apiTokens.revokedBadge")}</Badge>}
          {expired && <Badge variant="outline">{t("onboarding.apiTokens.expiredBadge")}</Badge>}
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <p className="truncate text-xs text-muted-foreground">{credential.name}</p>
          <ScopeChip credential={credential} orgs={orgs} projects={projects} />
        </div>
        <p className="text-[11px] text-muted-foreground">
          <DateTooltip value={credential.createdAt} label={t("common.date.created")}>
            {t("onboarding.apiTokens.createdOn", {
              date: fmtShortCalendarDate(credential.createdAt, undefined, locale),
            })}
          </DateTooltip>
          {" · "}
          {credential.expiresAt ? (
            <DateTooltip value={credential.expiresAt} label={t("common.date.expires")}>
              {t("common.expiresOn", {
                date: fmtShortCalendarDate(credential.expiresAt, undefined, locale),
              })}
            </DateTooltip>
          ) : t("common.noExpiry")}
          {credential.lastUsedAt ? (
            <>
              {" · "}
              <DateTooltip value={credential.lastUsedAt} label={t("common.date.lastUsed")}>
                {t("onboarding.apiTokens.lastUsedOn", {
                  date: fmtShortCalendarDate(credential.lastUsedAt, undefined, locale),
                })}
              </DateTooltip>
            </>
          ) : null}
        </p>
      </div>
      {!revoked && (
        <div className="flex shrink-0 items-center gap-1">
          <Button size="sm" variant="ghost" onClick={onShowInstructions}>
            {t("onboarding.apiTokens.agentSetupButton")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-muted-foreground hover:text-destructive"
            onClick={onRevoke}
          >
            {t("common.revoke")}
          </Button>
        </div>
      )}
    </li>
  )
}
