import type { CellSummary } from "@/hooks/useActiveCellStore"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { isStructuralCell } from "@/lib/cells/structural"
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
  /**
   * AQU-1083: does this project count chapter headings and section titles as
   * translatable content? Defaults to true, which is what every project did
   * before the setting existed.
   *
   * This footer is the ONE progress surface that counts cells itself rather
   * than reading a number the server computed, so it has to apply the policy
   * by hand — otherwise it contradicts the sidebar bar for the same file.
   */
  countStructural?: boolean
  className?: string
}

export function StatusBar({
  cells, projectHealth, healthMap, staleSourceCount, onJumpToCell,
  countStructural = true, className,
}: StatusBarProps) {
  const { locale, t } = useI18n()
  // Counted, not filtered in place: the health breakdown below still lists
  // every cell, because a heading whose health has decayed is still worth
  // jumping to even when it does not count toward the percentage.
  const counted = countStructural ? cells : cells.filter((c) => !isStructuralCell(c.type))
  const total = counted.length
  const empty = counted.filter((c) => c.status === "empty").length
  const unvalidated = counted.filter((c) => c.status === "unvalidated").length
  const validated = counted.filter((c) => c.status === "validated").length
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
        <span>
          {t("workspace.statusBar.summary", {
            total: totalDisplay,
            translated: translatedDisplay,
            pct: pctDisplay,
          })}
        </span>
        {unvalidated > 0 && (
          <Badge variant="secondary" className="text-amber-500">
            {t("workspace.statusBar.unvalidatedBadge", { count: unvalidated })}
          </Badge>
        )}
        {validated > 0 && (
          <Badge variant="secondary" className="text-green-500">
            {t("terminology.livingMemory.validatedCount", { count: validated })}
          </Badge>
        )}
      </span>
    </footer>
  )
}
