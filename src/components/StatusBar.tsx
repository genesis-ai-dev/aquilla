import type { CellSummary } from "@/hooks/useActiveCellStore"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { HealthRing } from "./HealthRing"
import { DecayBreakdown } from "./DecayBreakdown"
import { useI18n } from "@/lib/i18n/I18nProvider"
import { bidiIsolate, formatNumber, formatPercent } from "@/lib/i18n/format"

interface StatusBarProps {
  cells: readonly CellSummary[]
  projectHealth: number
  /** Per-cell decay health 0-100, keyed by cell id. Drives the breakdown. */
  healthMap: Map<string, number>
  staleSourceCount?: number
  onJumpToCell?: (cellId: string) => void
  className?: string
}

export function StatusBar({
  cells, projectHealth, healthMap, staleSourceCount, onJumpToCell, className,
}: StatusBarProps) {
  const { locale } = useI18n()
  const total = cells.length
  const empty = cells.filter((c) => c.status === "empty").length
  const unvalidated = cells.filter((c) => c.status === "unvalidated").length
  const validated = cells.filter((c) => c.status === "validated").length
  const translated = total - empty
  const fraction = total > 0 ? translated / total : 0
  // The ratio/percent run reorders under Arabic's bidi algorithm when this
  // footer sits inside an <html dir="rtl"> page (a user photographed exactly
  // this) even though the surrounding words stay English — isolate each
  // formatted numeric token so its digits/punctuation can't be reordered.
  const totalDisplay = bidiIsolate(formatNumber(total, locale))
  const translatedDisplay = bidiIsolate(formatNumber(translated, locale))
  const pctDisplay = bidiIsolate(`(${formatPercent(fraction, locale)})`)

  const healthByCell = cells.map((c) => ({
    cellId: c.id,
    label: c.cellLabel || c.id,
    health: healthMap.get(c.id) ?? 0,
  }))

  return (
    <footer className={cn(
      "relative z-10 flex items-center gap-2.5 px-4 py-2 text-sm text-muted-foreground",
      className,
    )}>
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
        <span>{totalDisplay} cells · {translatedDisplay} translated {pctDisplay}</span>
        {unvalidated > 0 && (
          <Badge variant="secondary" className="text-amber-500">
            {unvalidated} unvalidated
          </Badge>
        )}
        {validated > 0 && (
          <Badge variant="secondary" className="text-green-500">
            {validated} validated
          </Badge>
        )}
      </span>
    </footer>
  )
}
