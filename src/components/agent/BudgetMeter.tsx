/**
 * BudgetMeter.tsx — the run's cost-cap meter (AQU-AGENT §2
 * AGENT_RUN_COST_CAP_CENTS, §4 budget / budget.exhausted). Renders like
 * AgentRunView's usage line while the run is under cap, and switches to a
 * distinct alert once `budget.exhausted` lands explaining the run stopped.
 */

import { AlertTriangle, Gauge } from "lucide-react"
import { cn } from "@/lib/utils"
import type { AgentBudget } from "@/lib/agent/run-state"

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(cents < 1000 ? 2 : 0)}`
}

export function BudgetMeter({ budget }: { budget: AgentBudget }) {
  if (budget.exhausted) {
    return (
      <div
        role="alert"
        data-frame-type="budget.exhausted"
        className="flex items-center gap-1.5 rounded-md border border-destructive/50 bg-destructive/10 px-2.5 py-1.5 text-[11px] text-destructive"
      >
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
        <span>
          Run stopped at its {formatCents(budget.capCents)} cost cap ({formatCents(budget.spentCents)} spent).
        </span>
      </div>
    )
  }

  const pct = budget.capCents > 0 ? Math.min(100, (budget.spentCents / budget.capCents) * 100) : 0
  return (
    <div
      className="flex items-center gap-1.5 text-[10px] text-muted-foreground"
      role="status"
      data-frame-type="budget"
    >
      <Gauge className="h-3 w-3 shrink-0" />
      <div className="h-1 w-16 overflow-hidden rounded-full bg-muted">
        <div className={cn("h-full bg-sky-500", pct > 85 && "bg-amber-500")} style={{ width: `${pct}%` }} />
      </div>
      <span>
        {formatCents(budget.spentCents)} / {formatCents(budget.capCents)}
      </span>
    </div>
  )
}
