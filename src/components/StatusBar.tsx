import type { CellSummary } from "@/hooks/useActiveCellStore"
import { HealthRing } from "./HealthRing"
import { DecayBreakdown } from "./DecayBreakdown"

interface StatusBarProps {
  cells: readonly CellSummary[]
  projectHealth: number
  /** Per-cell decay health 0-100, keyed by cell id. Drives the breakdown. */
  healthMap: Map<string, number>
  staleSourceCount?: number
  onJumpToCell?: (cellId: string) => void
}

export function StatusBar({
  cells, projectHealth, healthMap, staleSourceCount, onJumpToCell,
}: StatusBarProps) {
  const total = cells.length
  const empty = cells.filter((c) => c.status === "empty").length
  const unvalidated = cells.filter((c) => c.status === "unvalidated").length
  const validated = cells.filter((c) => c.status === "validated").length
  const translated = total - empty
  const pct = total > 0 ? Math.round((translated / total) * 100) : 0

  const healthByCell = cells.map((c) => ({
    cellId: c.id,
    label: c.cellLabel || c.id,
    health: healthMap.get(c.id) ?? 0,
  }))

  return (
    <footer className="relative z-10 flex items-center gap-2.5 px-4 py-2 text-sm text-muted-foreground">
      <DecayBreakdown
        health={projectHealth}
        scopeLabel="project health"
        healthByCell={healthByCell}
        staleSourceCount={staleSourceCount}
        onJumpToCell={onJumpToCell}
      >
        <HealthRing health={projectHealth} size={18} strokeWidth={2}>
          <span className="text-[7px] font-bold">{projectHealth}</span>
        </HealthRing>
      </DecayBreakdown>
      <span className="flex items-center gap-2">
        <span>{total.toLocaleString()} cells · {translated} translated ({pct}%)</span>
        {unvalidated > 0 && (
          <span className="bg-muted rounded-full px-2 py-0.5 text-xs text-amber-500">{unvalidated} unvalidated</span>
        )}
        {validated > 0 && (
          <span className="bg-muted rounded-full px-2 py-0.5 text-xs text-green-500">{validated} validated</span>
        )}
      </span>
    </footer>
  )
}
