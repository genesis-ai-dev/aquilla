import { useState } from "react"
import { Input } from "@/components/ui/input"
import type { AdminBillingOrg, AdminFieldPlan, OrgTier } from "@/lib/frontier/admin"

/**
 * AQU-2067 (unified billing T10): the per-org plan control and the global Free
 * cap's Team readout. Spec §4: every org has one plan (free | team |
 * enterprise); Enterprise may carry a contract end, then a 14-day Team-sized
 * grace, then Free.
 */

const usd = (n: number) => `$${n.toFixed(2)}`
const dateOnly = (iso: string | null) => (iso ? iso.slice(0, 10) : "")

/** Team = multiple × Free. Shown live from the unsaved input so the admin sees
 * the cost before saving, and warned when it passes the revenue share (spec Q7). */
export function TeamCostLine({ freeWeeklyRawUsd, plan }: { freeWeeklyRawUsd: string; plan: AdminFieldPlan }) {
  const free = Number(freeWeeklyRawUsd)
  const cost = plan.teamCost
  if (!cost || !Number.isFinite(free) || free < 0) return null
  const multiple = plan.teamMultipleOfFree ?? 24
  const teamRaw = free * multiple
  const share = teamRaw / cost.teamWeeklyRevenueUsd
  const over = share > cost.maxCostShare
  return (
    <div className="mt-3 text-xs" data-testid="team-implied-cost">
      <p className="text-muted-foreground">
        Team ({multiple}× Free) at 100% use = <span className="font-semibold tabular-nums text-foreground">{usd(teamRaw)}/week raw</span>,{" "}
        {Math.round(share * 100)}% of Team revenue ({usd(cost.teamWeeklyRevenueUsd)}/week on the annual price).
      </p>
      {over ? (
        <p className="mt-1 text-amber-700 dark:text-amber-400" role="alert" data-testid="team-cost-warning">
          Team at full use would cost more than {Math.round(cost.maxCostShare * 100)}% of its revenue. Lower the Free cap to stay
          under {usd((cost.maxCostShare * cost.teamWeeklyRevenueUsd) / multiple)}/week.
        </p>
      ) : null}
    </div>
  )
}

/** What the resolver answers now, in words: Stripe and contract grace make the
 * effective plan differ from the one an admin set. */
function planStatus(org: AdminBillingOrg, now = Date.now()): string {
  if (org.planSource === "contract_grace") return `Contract ended · Team-sized grace until ${dateOnly(org.graceEndsAt)}`
  if (org.planSource === "stripe") return "Paid Team via Stripe"
  if (org.tier === "enterprise" && org.resolvedTier === "free") return "Contract and grace ended · now Free"
  if (org.resolvedTier === "enterprise") {
    if (!org.contractEndsAt) return "Unmetered · no end date"
    return Date.parse(org.contractEndsAt) > now ? `Unmetered · contract ends ${dateOnly(org.contractEndsAt)}` : "Unmetered"
  }
  return ""
}

export function OrgPlanControl({
  org,
  onCommit,
}: {
  org: AdminBillingOrg
  onCommit: (plan: { tier: OrgTier; contractEndsAt?: string | null }) => void
}) {
  const name = org.orgName ?? String(org.orgId)
  const savedEnds = dateOnly(org.contractEndsAt)
  const [ends, setEnds] = useState(savedEnds)
  // Re-sync the draft when a save or refresh changes the stored date.
  const [synced, setSynced] = useState(savedEnds)
  if (synced !== savedEnds) { setSynced(savedEnds); setEnds(savedEnds) }
  const status = planStatus(org)
  return (
    <div className="flex min-w-[150px] flex-col gap-1">
      <select
        aria-label={`plan for ${name}`}
        className="h-7 rounded-md border bg-background px-1.5 text-xs"
        value={org.tier}
        onChange={(e) => {
          const tier = e.target.value as OrgTier
          onCommit(tier === "enterprise" ? { tier, contractEndsAt: null } : { tier })
        }}
      >
        <option value="free">Free</option>
        <option value="team">Team</option>
        <option value="enterprise">Enterprise</option>
      </select>
      {org.tier === "enterprise" ? (
        <label className="flex items-center gap-1 text-[10px] text-muted-foreground">
          Ends
          <Input
            type="date"
            aria-label={`contract end for ${name}`}
            className="h-7 w-[8.5rem] text-xs"
            value={ends}
            onChange={(e) => setEnds(e.target.value)}
            onBlur={() => {
              if (ends === savedEnds) return
              onCommit({ tier: "enterprise", contractEndsAt: ends ? `${ends}T00:00:00Z` : null })
            }}
          />
        </label>
      ) : null}
      {status ? (
        <span
          className={`text-[10px] ${org.planSource === "contract_grace" ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground"}`}
          data-testid={`plan-status-${org.orgId}`}
        >
          {status}
        </span>
      ) : null}
    </div>
  )
}

/** Per-org weekly allowance in raw provider dollars; blank = the plan default. */
export function WeeklyAllowanceUsd({
  org,
  unitsPerRawUsd,
  onCommit,
}: {
  org: AdminBillingOrg
  unitsPerRawUsd: number
  onCommit: (rawUsd: number | null) => void
}) {
  const stored = org.weeklyAllowance == null ? null : org.weeklyAllowance / unitsPerRawUsd
  const [local, setLocal] = useState(stored == null ? "" : String(stored))
  const [synced, setSynced] = useState(stored)
  if (synced !== stored) { setSynced(stored); setLocal(stored == null ? "" : String(stored)) }
  const effective = org.effectiveWeeklyAllowance
  return (
    <div className="flex flex-col gap-0.5">
      <Input
        type="number"
        min={0}
        step="0.01"
        aria-label={`weekly allowance for ${org.orgName ?? org.orgId}`}
        data-testid={`weekly-allowance-${org.orgId}`}
        placeholder="plan default"
        value={local}
        onChange={(e) => setLocal(e.target.value)}
        onBlur={() => {
          if (local.trim() === "") {
            if (stored != null) onCommit(null)
            return
          }
          const n = Number(local)
          if (Number.isFinite(n) && n >= 0 && n <= 10_000 && n !== stored) onCommit(n)
        }}
        className="h-7 w-24 text-xs tabular-nums"
      />
      <span className="text-[10px] text-muted-foreground tabular-nums">
        {effective == null ? "unmetered" : `in effect ${usd(effective / unitsPerRawUsd)}/wk`}
      </span>
    </div>
  )
}
