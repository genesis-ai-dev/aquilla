import { useMemo } from "react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { DECAY_DEFAULTS } from "@/lib/health/decay-engine"

interface DecayBreakdownProps {
  /** Scope health 0-100 (1 - mean(decay)). */
  health: number
  /** Short scope label, e.g. "project health". */
  scopeLabel: string
  /** Per-cell health 0-100 (decay-derived) for every cell in scope. */
  healthByCell: Array<{ cellId: string; label: string; health: number }>
  /** Decay warn threshold (0-1). Cells above it "need attention". */
  warnThreshold?: number
  /** Number of cells whose pinned source has advanced (AD-9). Optional row. */
  staleSourceCount?: number
  onJumpToCell?: (cellId: string) => void
  children: React.ReactNode
}

/**
 * AD-14 health breakdown popover. Replaces the retired four-sub-score
 * breakdown. Shows the "biggest drags" — cells sorted by descending decay
 * (ascending health) — plus a single "X% of cells need attention" summary.
 * Stale-source is a separate sibling row, never folded into the number.
 */
export function DecayBreakdown({
  health,
  scopeLabel,
  healthByCell,
  warnThreshold = DECAY_DEFAULTS.decayWarnThreshold,
  staleSourceCount,
  onJumpToCell,
  children,
}: DecayBreakdownProps) {
  // needsAttention ⟺ decay > warnThreshold ⟺ health < (1 - warnThreshold)*100.
  const attentionHealthCutoff = (1 - warnThreshold) * 100

  const { needsAttentionPct, drags } = useMemo(() => {
    const total = healthByCell.length
    const attention = healthByCell.filter((c) => c.health < attentionHealthCutoff)
    const drags = [...attention]
      .sort((a, b) => a.health - b.health)
      .slice(0, 8)
    return {
      needsAttentionPct: total > 0 ? Math.round((attention.length / total) * 100) : 0,
      drags,
    }
  }, [healthByCell, attentionHealthCutoff])

  return (
    <Popover>
      <PopoverTrigger nativeButton={false} openOnHover delay={300} closeDelay={120} render={<span className="inline-flex">{children}</span>} />
      <PopoverContent side="top" align="start" className="w-72 rounded-lg border-0 bg-card p-3">
        <div className="mb-2 flex items-baseline justify-between">
          <span className="text-xs font-medium text-muted-foreground">
            {scopeLabel}
          </span>
          <span className="text-sm font-semibold tabular-nums">{health}%</span>
        </div>

        <p className="mb-2 text-xs text-muted-foreground">
          {needsAttentionPct}% of cells need attention
        </p>

        {typeof staleSourceCount === "number" && staleSourceCount > 0 && (
          <p className="mb-2 text-xs text-amber-600">
            {staleSourceCount} cell{staleSourceCount === 1 ? "" : "s"} with stale source
          </p>
        )}

        {drags.length > 0 ? (
          <>
            <p className="mb-1 text-xs text-muted-foreground">
              Biggest drags
            </p>
            <ul className="space-y-0.5">
              {drags.map((c) => (
                <li key={c.cellId}>
                  <button
                    type="button"
                    className="flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1 text-left text-xs transition-all hover:bg-card"
                    onClick={() => onJumpToCell?.(c.cellId)}
                    disabled={!onJumpToCell}
                  >
                    <span className="truncate">{c.label}</span>
                    <span className="flex-shrink-0 tabular-nums text-muted-foreground">{c.health}%</span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="text-xs text-muted-foreground">No cells need attention.</p>
        )}
      </PopoverContent>
    </Popover>
  )
}
