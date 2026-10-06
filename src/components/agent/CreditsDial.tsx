/**
 * CreditsDial — at-a-glance org agent-credit gauge, shown beside the agent
 * chat composer (via AgentUsageRing) for maintainers.
 *
 * A small ring shows today's agent-rail spend against the org's agent daily
 * cap; clicking opens a popover with the full breakdown (agent day/week +
 * all-rail totals), in CREDITS only — same rules as the org CreditsPanel.
 *
 * VISIBILITY — the same double gate as CreditsPanel:
 *   1. Role gate: viewer's org role must be >= MAINTAINER (600). Translators
 *      must never see credit/cost data.
 *   2. Server gate: getOrgCredits returns null on 403 (not maintainer server-
 *      side, or showToOrg off) → the dial self-hides.
 */

import { useCallback, useEffect, useState } from "react"
import { getOrgCredits, type OrgCredits } from "@/lib/sync/credits"
import { formatCredits, capUsagePct } from "@/lib/credits"
import { ROLE } from "@/lib/frontier/roles"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { AppTooltip } from "@/components/ui/tooltip"
import { useT } from "@/lib/i18n/I18nProvider"
import { UsageRingIcon } from "./UsageRingIcon"

export interface CreditsDialProps {
  jwt: string
  orgId: number
  /** The viewer's numeric org role level (from OrgSummary.role.level). */
  orgRoleLevel: number
  /** Re-fetch when this changes (e.g. after each agent run settles). */
  refreshKey?: unknown
}

export function CreditsDial({ jwt, orgId, orgRoleLevel, refreshKey }: CreditsDialProps) {
  const t = useT()
  const [data, setData] = useState<OrgCredits | null>(null)
  const [open, setOpen] = useState(false)

  const refresh = useCallback(() => {
    if (orgRoleLevel < ROLE.MAINTAINER) return
    getOrgCredits(jwt, orgId)
      .then(setData)
      .catch(() => setData(null)) // transient error → hide
  }, [jwt, orgId, orgRoleLevel])

  useEffect(() => {
    refresh()
  }, [refresh, refreshKey])

  // Role gate (double-check): non-maintainers never see credit data.
  if (orgRoleLevel < ROLE.MAINTAINER) return null
  if (!data) return null

  const { day, week, config, remaining } = data
  const pct = capUsagePct(day.agentCredits, config.agentDailyCap)

  const summary = t("onboarding.credits.dialSummary", { credits: formatCredits(day.agentCredits) })

  return (
    <Popover open={open} onOpenChange={setOpen}>
      {/* Suppressed while the popover is open: it sits over the same anchor and
          the popover already spells out the breakdown. AppTooltip must stay
          mounted (disabled={open}) — unmounting remounts PopoverTrigger and
          flashes the popover at the top-left until the new anchor measures. */}
      <AppTooltip content={summary} disabled={open}>
        <PopoverTrigger
          render={
            <button
              type="button"
              onClick={refresh}
              data-testid="credits-dial"
              aria-label={summary}
              className="inline-flex size-8 items-center justify-center text-muted-foreground hover:text-foreground"
            />
          }
        >
          <UsageRingIcon pct={pct} />
        </PopoverTrigger>
      </AppTooltip>
      <PopoverContent side="top" align="start" className="w-64 p-3 text-xs" data-testid="credits-dial-popover">
        <p className="mb-2 font-medium">{t("onboarding.credits.popoverAgentTitle")}</p>
        <div className="space-y-1.5">
          <DialRow label={t("onboarding.timeWindow.today")} used={day.agentCredits} cap={config.agentDailyCap} testId="dial-agent-day" />
          <DialRow label={t("onboarding.timeWindow.thisWeek")} used={week.agentCredits} cap={config.agentWeeklyCap} testId="dial-agent-week" />
        </div>
        <p className="mb-1.5 mt-3 font-medium text-muted-foreground">{t("onboarding.credits.popoverAllUsageTitle")}</p>
        <div className="space-y-1.5">
          <DialRow label={t("onboarding.timeWindow.today")} used={day.totalCredits} cap={config.dailyCap} testId="dial-total-day" />
          <DialRow label={t("onboarding.timeWindow.thisWeek")} used={week.totalCredits} cap={config.weeklyCap} testId="dial-total-week" />
        </div>
        <p className="mt-3 text-[10px] text-muted-foreground">
          {t("onboarding.credits.dialFooter", { remaining: formatCredits(Math.max(0, remaining.agentDaily)) })}
        </p>
      </PopoverContent>
    </Popover>
  )
}

/** Label · thin bar · used/cap. Same read as the org panel's AgentCapRow. */
function DialRow({ label, used, cap, testId }: { label: string; used: number; cap: number; testId: string }) {
  const pct = capUsagePct(used, cap)
  return (
    <div className="flex items-center gap-2">
      <span className="w-14 shrink-0 text-[11px] text-muted-foreground">{label}</span>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
        <div
          className={`h-full rounded-full ${pct >= 85 ? "bg-red-500" : pct >= 60 ? "bg-amber-500" : "bg-sky-500"}`}
          style={{ width: `${pct}%` }}
          aria-hidden
        />
      </div>
      <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground" data-testid={testId}>
        <span className="font-medium text-foreground">{formatCredits(used)}</span> / {formatCredits(cap)}
      </span>
    </div>
  )
}
