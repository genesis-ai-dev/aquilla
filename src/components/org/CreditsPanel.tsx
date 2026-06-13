import { useEffect, useState } from "react"
import { getOrgCredits, type OrgCredits } from "@/lib/sync/credits"
import { formatCredits, capUsagePct } from "@/lib/credits"
import { ROLE } from "@/lib/frontier/roles"

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
}: {
  jwt: string
  orgId: number
  /** The viewer's numeric org role level (from OrgSummary.role.level). */
  orgRoleLevel: number
}) {
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
  const dayPct = capUsagePct(day.totalCredits, config.dailyCap)
  const weekPct = capUsagePct(week.totalCredits, config.weeklyCap)
  const agentDayPct = capUsagePct(day.agentCredits, config.agentDailyCap)
  const agentWeekPct = capUsagePct(week.agentCredits, config.agentWeeklyCap)

  return (
    <div className="rounded-lg border p-4" data-testid="credits-panel">
      <h2 className="text-sm font-semibold">Compute credits</h2>
      <p className="mt-0.5 text-xs text-muted-foreground">Daily and weekly cap usage</p>

      <div className="mt-4 space-y-4">
        {/* Daily total */}
        <CapBar
          label="Today"
          used={day.totalCredits}
          cap={config.dailyCap}
          pct={dayPct}
          variant="default"
        />

        {/* Weekly total */}
        <CapBar
          label="This week"
          used={week.totalCredits}
          cap={config.weeklyCap}
          pct={weekPct}
          variant="default"
        />

        {/* Agent sub-cap — visually highlighted as the dangerous rail */}
        <div className="rounded-md border border-amber-200 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950/40">
          <p className="mb-2 text-xs font-medium text-amber-800 dark:text-amber-300">
            Agent spend (elevated rail)
          </p>
          <div className="space-y-2">
            <CapBar
              label="Agent today"
              used={day.agentCredits}
              cap={config.agentDailyCap}
              pct={agentDayPct}
              variant="agent"
            />
            <CapBar
              label="Agent this week"
              used={week.agentCredits}
              cap={config.agentWeeklyCap}
              pct={agentWeekPct}
              variant="agent"
            />
          </div>
        </div>
      </div>

      {!config.enforce && (
        <p className="mt-3 text-xs text-muted-foreground">
          Caps are display-only — enforcement is off for this org.
        </p>
      )}
    </div>
  )
}

function CapBar({
  label,
  used,
  cap,
  pct,
  variant,
}: {
  label: string
  used: number
  cap: number
  pct: number
  variant: "default" | "agent"
}) {
  const barColor =
    pct >= 90
      ? "bg-destructive"
      : pct >= 70
        ? "bg-amber-500"
        : variant === "agent"
          ? "bg-amber-400"
          : "bg-primary"

  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between">
        <span className="text-xs text-muted-foreground">{label}</span>
        <span className="text-xs tabular-nums font-medium">
          {formatCredits(used)}
          <span className="font-normal text-muted-foreground"> / {formatCredits(cap)}</span>
          <span className="ml-1 text-muted-foreground">({pct}%)</span>
        </span>
      </div>
      <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
        <div
          className={`h-full rounded-full ${barColor} transition-all`}
          style={{ width: `${pct}%` }}
          aria-label={`${pct}% of ${label} cap used`}
        />
      </div>
    </div>
  )
}
