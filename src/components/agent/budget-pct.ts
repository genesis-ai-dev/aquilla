import type { AgentBudget } from "@/lib/agent/run-state"

/** Percent of the run's cap spent. Percentage only (2026-08-31 review): raw
 *  "1 cr / 2,500 cr" reads as billing noise; a percent answers "how much
 *  runway is left". Tiny non-zero spend floors at "<1" rather than "0". */
export function budgetPct(budget: AgentBudget): { pct: number; pctLabel: string } {
  const pct = budget.capCredits > 0 ? Math.min(100, (budget.spentCredits / budget.capCredits) * 100) : 0
  const pctLabel = budget.spentCredits > 0 && pct < 1 ? "<1" : String(Math.round(pct))
  return { pct, pctLabel }
}
