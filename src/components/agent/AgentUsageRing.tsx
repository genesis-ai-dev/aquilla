/**
 * AgentUsageRing — the usage gauge beside the agent chat composer. It replaces
 * the per-message token/credit line: usage is one glance away, not repeated
 * under every reply.
 *
 * Role-aware:
 *   - Maintainer+: the org CreditsDial (today's agent spend vs. the daily cap,
 *     with a breakdown popover). Credit figures stay behind its double gate;
 *     when the server hides them (403), the run-budget ring stands in.
 *   - Everyone else: the latest run's budget as a percentage only — the same
 *     figure BudgetMeter showed inline, never credits.
 */

import { ROLE } from "@/lib/frontier/roles"
import { AppTooltip } from "@/components/ui/tooltip"
import { useT } from "@/lib/i18n/I18nProvider"
import type { AgentBudget, AgentRunUi } from "@/lib/agent/run-state"
import { budgetPct } from "./budget-pct"
import { CreditsDial, type CreditsDialProps } from "./CreditsDial"
import { UsageRingIcon } from "./UsageRingIcon"

export interface AgentUsageRingProps {
  credits?: CreditsDialProps | null
  runs: readonly AgentRunUi[]
  isStreaming: boolean
}

export function AgentUsageRing({ credits, runs, isStreaming }: AgentUsageRingProps) {
  const budget = runs.findLast((run) => run.budget)?.budget
  const runRing = budget ? <RunBudgetRing budget={budget} /> : null
  if (credits && credits.orgRoleLevel >= ROLE.MAINTAINER) {
    // Re-fetch org spend once a run settles, so the ring isn't stale.
    return <CreditsDial {...credits} refreshKey={isStreaming ? -1 : runs.length} fallback={runRing} />
  }
  return runRing
}

function RunBudgetRing({ budget }: { budget: AgentBudget }) {
  const t = useT()
  const { pct, pctLabel } = budgetPct(budget)
  const label = t("agent.budget.pctUsed", { pct: pctLabel })
  return (
    <AppTooltip content={label}>
      <span
        role="img"
        tabIndex={0}
        aria-label={label}
        data-testid="run-budget-ring"
        className="inline-flex size-8 items-center justify-center text-muted-foreground"
      >
        <UsageRingIcon pct={pct} />
      </span>
    </AppTooltip>
  )
}
