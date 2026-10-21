/**
 * AgentUsageRing — the usage gauge beside the agent chat composer. It replaces
 * the per-message token/credit line: usage is one glance away, not repeated
 * under every reply.
 *
 * AQU-2068: everyone sees the org's one % meter (compact form), the same
 * meter as the org overview and billing page, with a note that agent runs
 * drain it faster. Credits never show here. When the meter cannot load (no
 * org, signed out, read failed) the latest run's budget % stands in.
 */

import { AppTooltip } from "@/components/ui/tooltip"
import { AiMeterCompact, type AiMeterProps } from "@/components/billing/AiMeter"
import { useT } from "@/lib/i18n/I18nProvider"
import type { AgentBudget, AgentRunUi } from "@/lib/agent/run-state"
import { budgetPct } from "./budget-pct"
import { UsageRingIcon } from "./UsageRingIcon"

export interface AgentUsageRingProps {
  meter?: AiMeterProps | null
  runs: readonly AgentRunUi[]
}

export function AgentUsageRing({ meter, runs }: AgentUsageRingProps) {
  if (meter && meter.view.kind !== "loading" && meter.view.kind !== "unavailable") {
    return <AiMeterCompact {...meter} />
  }
  const budget = runs.findLast((run) => run.budget)?.budget
  return budget ? <RunBudgetRing budget={budget} /> : null
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
