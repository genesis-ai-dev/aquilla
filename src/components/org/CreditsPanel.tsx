import { useEffect, useState, type ReactNode } from "react"
import { getOrgCredits, type OrgCredits } from "@/lib/sync/credits"
import { formatCredits, capUsagePct } from "@/lib/credits"
import { ROLE } from "@/lib/frontier/roles"
import { Section } from "@/components/ui/page"
import { SegmentedCapBar, RailLegend } from "@/components/credits/credit-visuals"
import { pctTextClass } from "@/components/credits/rails"
import { useI18n, useT } from "@/lib/i18n/I18nProvider"

/**
 * Credit cap usage panel for the org Overview (maintainer+ view).
 *
 * VISIBILITY RULES — two independent gates, BOTH must pass:
 *   1. Role gate: viewer's org role must be >= MAINTAINER (600). Translators
 *      (< 600) must never see credit/cost data under any circumstances.
 *   2. Flag gate: backend returns 403 (→ null) when showToOrg is off, so the
 *      component self-hides on null regardless of role.
 *
 * WHY the double gate matters: the role check is a client-side UX guard; the
 * 403→null is the server enforced boundary. Both must hold because either can
 * be bypassed in isolation (stale role data / misconfigured server). The
 * translator-never-sees-it invariant is encoded in the tests.
 *
 * Shows daily/weekly credit cap usage bars + agent sub-cap in credits.
 * No raw provider $ amounts — credits only, per spec.
 */
export function CreditsPanel({
  jwt,
  orgId,
  orgRoleLevel,
  action,
}: {
  jwt: string
  orgId: number
  /** The viewer's numeric org role level (from OrgSummary.role.level). */
  orgRoleLevel: number
  action?: ReactNode
}) {
  const t = useT()
  const [data, setData] = useState<OrgCredits | null>(null)

  useEffect(() => {
    // Role gate: skip the fetch entirely for non-maintainers.
    // WHY: avoids a pointless 403 on every overview load for translators, and
    // ensures the translator-never-sees-it invariant is enforced client-side too.
    if (orgRoleLevel < ROLE.MAINTAINER) return

    let cancelled = false
    getOrgCredits(jwt, orgId)
      .then((d) => { if (!cancelled) setData(d) })
      .catch(() => { if (!cancelled) setData(null) }) // transient error → hide
    return () => { cancelled = true }
  }, [jwt, orgId, orgRoleLevel])

  // Role gate (double-check after fetch): non-maintainers never see this panel.
  // WHY: even if data somehow arrived, translators must not see cost signals.
  if (orgRoleLevel < ROLE.MAINTAINER) return null

  // null = 403 (showToOrg off, or not maintainer server-side) or error → hide.
  if (!data) return null

  const { day, week, config } = data

  return (
    <Section
      title={t("onboarding.credits.panelTitle")}
      description={t("onboarding.credits.panelDescription")}
      action={action}
      data-testid="credits-panel"
    >
      <div className="space-y-5">
        {/* Overall caps — total fill = spend/cap, segmented by rail. */}
        <CapWindow label={t("onboarding.timeWindow.today")} total={day.totalCredits} cap={config.dailyCap} byRail={day.byRail} window="day" />
        <CapWindow label={t("onboarding.timeWindow.thisWeek")} total={week.totalCredits} cap={config.weeklyCap} byRail={week.byRail} window="week" />

        {/* Agent sub-cap — the totals above already include this; it's broken
            out because agent is the elevated rail (own cap, 5× markup, fastest
            to compound). NOT a duplicate — a subset with its own limit. */}
        <div className="rounded-xl border border-amber-200/70 bg-amber-50/50 px-3 py-2.5 dark:border-amber-900/50 dark:bg-amber-950/20">
          <div className="mb-2 flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
            <p className="text-[11px] font-medium text-amber-800 dark:text-amber-300">
              {t("onboarding.credits.agentSpendNote")}
            </p>
          </div>
          <div className="space-y-1.5">
            <AgentCapRow label={t("onboarding.timeWindow.today")} used={day.agentCredits} cap={config.agentDailyCap} testId="agentcap-day" />
            <AgentCapRow label={t("onboarding.timeWindow.thisWeek")} used={week.agentCredits} cap={config.agentWeeklyCap} testId="agentcap-week" />
          </div>
        </div>
      </div>
    </Section>
  )
}

/** One window (Today / This week): total vs cap + a rail-segmented bar + legend. */
function CapWindow({
  label,
  total,
  cap,
  byRail,
  window,
}: {
  label: string
  total: number
  cap: number
  byRail: Record<string, number>
  window: "day" | "week"
}) {
  const { locale } = useI18n()
  const pct = capUsagePct(total, cap)
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium">{label}</span>
        <span className="text-xs tabular-nums" data-testid={`cap-${window}-total`}>
          <span className="font-semibold">{formatCredits(total, locale)}</span>
          <span className="text-muted-foreground"> / {formatCredits(cap, locale)}</span>
          <span className={`ms-1.5 font-medium ${pctTextClass(pct)}`}>{pct}%</span>
        </span>
      </div>
      <SegmentedCapBar byRail={byRail} cap={cap} />
      <div className="mt-1.5">
        <RailLegend byRail={byRail} chipTestId={(rail) => `rail-${window}-${rail}`} />
      </div>
    </div>
  )
}

/** Compact agent sub-cap row: label · thin amber bar · used/cap · %. */
function AgentCapRow({
  label,
  used,
  cap,
  testId,
}: {
  label: string
  used: number
  cap: number
  testId: string
}) {
  const { locale } = useI18n()
  const pct = capUsagePct(used, cap)
  return (
    <div className="flex items-center gap-2.5">
      <span className="w-16 shrink-0 text-[11px] text-muted-foreground">{label}</span>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-amber-100 dark:bg-amber-950/50">
        <div className="h-full rounded-full bg-amber-500" style={{ width: `${pct}%` }} aria-hidden />
      </div>
      <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground" data-testid={testId}>
        <span className="font-medium text-foreground">{formatCredits(used, locale)}</span> / {formatCredits(cap, locale)}
        <span className="ms-1">· {pct}%</span>
      </span>
    </div>
  )
}
