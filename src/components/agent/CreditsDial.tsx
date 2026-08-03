/**
 * CreditsDial — at-a-glance org agent-credit gauge for the agent surfaces
 * (dock panel + workbench headers).
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

export interface CreditsDialProps {
  jwt: string
  orgId: number
  /** The viewer's numeric org role level (from OrgSummary.role.level). */
  orgRoleLevel: number
}

/** Ring color mirrors the cap-pressure convention used elsewhere. */
function ringClass(pct: number): string {
  if (pct >= 85) return "stroke-red-500"
  if (pct >= 60) return "stroke-amber-500"
  return "stroke-sky-500"
}

export function CreditsDial({ jwt, orgId, orgRoleLevel }: CreditsDialProps) {
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
  }, [refresh])

  // Role gate (double-check): non-maintainers never see credit data.
  if (orgRoleLevel < ROLE.MAINTAINER) return null
  if (!data) return null

  const { day, week, config, remaining } = data
  const pct = capUsagePct(day.agentCredits, config.agentDailyCap)

  // Ring drawn in a 12x12 box, rendered at 16px. The radius insets by half the
  // stroke so the arc stays inside the box at this weight.
  const stroke = 2.5
  const r = (12 - stroke) / 2
  const C = 2 * Math.PI * r

  const summary = `Agent credits used today: ${formatCredits(day.agentCredits)}`

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
              className="inline-flex items-center justify-center text-muted-foreground hover:text-foreground"
            />
          }
        >
          <svg viewBox="0 0 12 12" className="size-4 -rotate-90" aria-hidden>
            <circle
              cx="6"
              cy="6"
              r={r}
              fill="none"
              strokeWidth={stroke}
              className="stroke-muted-foreground/25"
            />
            <circle
              cx="6"
              cy="6"
              r={r}
              fill="none"
              strokeWidth={stroke}
              strokeLinecap="round"
              strokeDasharray={`${(pct / 100) * C} ${C}`}
              className={ringClass(pct)}
            />
          </svg>
        </PopoverTrigger>
      </AppTooltip>
      <PopoverContent align="end" className="w-64 p-3 text-xs" data-testid="credits-dial-popover">
        <p className="mb-2 font-medium">Agent credits</p>
        <div className="space-y-1.5">
          <DialRow label="Today" used={day.agentCredits} cap={config.agentDailyCap} testId="dial-agent-day" />
          <DialRow label="This week" used={week.agentCredits} cap={config.agentWeeklyCap} testId="dial-agent-week" />
        </div>
        <p className="mb-1.5 mt-3 font-medium text-muted-foreground">All AI usage (every rail)</p>
        <div className="space-y-1.5">
          <DialRow label="Today" used={day.totalCredits} cap={config.dailyCap} testId="dial-total-day" />
          <DialRow label="This week" used={week.totalCredits} cap={config.weeklyCap} testId="dial-total-week" />
        </div>
        <p className="mt-3 text-[10px] text-muted-foreground">
          {formatCredits(Math.max(0, remaining.agentDaily))} agent credits left today · caps set by your org
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
