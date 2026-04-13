import type { CellData } from "@/hooks/useCells"
import { HealthRing } from "./HealthRing"

interface StatusBarProps {
  cells: CellData[]
  projectHealth: number
}

export function StatusBar({ cells, projectHealth }: StatusBarProps) {
  const total = cells.length
  const empty = cells.filter((c) => c.status === "empty").length
  const unvalidated = cells.filter((c) => c.status === "unvalidated").length
  const validated = cells.filter((c) => c.status === "validated").length
  const translated = total - empty
  const pct = total > 0 ? Math.round((translated / total) * 100) : 0

  return (
    <footer className="flex items-center gap-2 border-t px-4 py-1.5 text-sm text-muted-foreground">
      <HealthRing health={projectHealth} size={18} strokeWidth={2}>
        <span className="text-[7px] font-bold">{projectHealth}</span>
      </HealthRing>
      <span>
        {total.toLocaleString()} cells · {translated} translated ({pct}%)
        {unvalidated > 0 && <span className="ml-2 text-amber-500">· {unvalidated} unvalidated</span>}
        {validated > 0 && <span className="ml-2 text-green-500">· {validated} validated</span>}
      </span>
    </footer>
  )
}
