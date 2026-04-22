import type { CellData } from "@/hooks/useCells"
import type { CellHealthBreakdown } from "@/lib/parsers/types"
import { HealthRing } from "./HealthRing"
import { HealthBreakdown } from "./HealthBreakdown/HealthBreakdown"

interface StatusBarProps {
  cells: CellData[]
  projectHealth: number
  projectBreakdown?: CellHealthBreakdown
  biggestDrags?: Array<{ cellId: string; score: number }>
  onJumpToCell?: (cellId: string) => void
}

export function StatusBar({
  cells, projectHealth, projectBreakdown, biggestDrags, onJumpToCell,
}: StatusBarProps) {
  const total = cells.length
  const empty = cells.filter((c) => c.status === "empty").length
  const unvalidated = cells.filter((c) => c.status === "unvalidated").length
  const validated = cells.filter((c) => c.status === "validated").length
  const translated = total - empty
  const pct = total > 0 ? Math.round((translated / total) * 100) : 0

  const ringEl = (
    <HealthRing health={projectHealth} size={18} strokeWidth={2}>
      <span className="text-[7px] font-bold">{projectHealth}</span>
    </HealthRing>
  )

  return (
    <footer className="flex items-center gap-2 border-t px-4 py-1.5 text-sm text-muted-foreground">
      {projectBreakdown ? (
        <HealthBreakdown
          breakdown={projectBreakdown}
          scopeLabel="project health"
          onCellClick={onJumpToCell}
          majorInfractionCount={0}
          biggestDrags={biggestDrags}
        >
          {ringEl}
        </HealthBreakdown>
      ) : ringEl}
      <span>
        {total.toLocaleString()} cells · {translated} translated ({pct}%)
        {unvalidated > 0 && <span className="ml-2 text-amber-500">· {unvalidated} unvalidated</span>}
        {validated > 0 && <span className="ml-2 text-green-500">· {validated} validated</span>}
      </span>
    </footer>
  )
}
