import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { HealthRing } from "./HealthRing"
import { DecayBreakdown } from "./DecayBreakdown"
import { useI18n } from "@/lib/i18n/I18nProvider"
import { bidiIsolate, formatNumber, formatPercent } from "@/lib/i18n/format"

interface StatusBarProps {
  progress: { total: number; translated: number; validated: number }
  getHealthByCell: () => Array<{ cellId: string; label: string; health: number }>
  projectHealth: number
  staleSourceCount?: number
  onJumpToCell?: (cellId: string) => void
  /**
   * AQU-1083: `progress` must already reflect the project's structural-cell
   * policy — this footer no longer sees cells, so it cannot apply it itself.
   * ProjectWorkspace resolves it with `applyStructuralPolicy` before passing
   * the numbers down; see `@/lib/cells/structural`.
   */
  className?: string
}

export function StatusBar({
  progress, getHealthByCell, projectHealth, staleSourceCount, onJumpToCell, className,
}: StatusBarProps) {
  const { locale, t } = useI18n()
  const { total, translated, validated } = progress
  const unvalidated = translated - validated
  const fraction = total > 0 ? translated / total : 0
  // The ratio/percent run reorders under Arabic's bidi algorithm when this
  // footer sits inside an <html dir="rtl"> page (a user photographed exactly
  // this) even though the surrounding words stay English — isolate each
  // formatted numeric token so its digits/punctuation can't be reordered.
  const totalDisplay = bidiIsolate(formatNumber(total, locale))
  const translatedDisplay = bidiIsolate(formatNumber(translated, locale))
  const pctDisplay = bidiIsolate(`(${formatPercent(fraction, locale)})`)

  return (
    <footer className={cn(
      "relative z-10 flex items-center gap-2.5 px-4 py-2 text-sm text-muted-foreground",
      className,
    )}>
      <DecayBreakdown
        health={projectHealth}
        scopeLabel="project health"
        getHealthByCell={getHealthByCell}
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
