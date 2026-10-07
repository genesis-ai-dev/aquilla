import { cn } from "@/lib/utils"
import { progressPercentOfFraction } from "@/lib/progress/progress-percent"

/**
 * A slim validated-progress bar + percentage. Colour tracks completion so a
 * glance down a column reads as a heat map (red early → primary as it fills).
 */
export function ValidatedBar({ fraction, className }: { fraction: number; className?: string }) {
  // AQU-1493: 100 (and the "done" green) only when every cell is validated —
  // rounding let a project 1 of 1,208 short read as a full green 100% beside
  // the "99% Avg validated" tile above it on the org Overview.
  const pct = progressPercentOfFraction(fraction)
  const color = pct >= 100 ? "bg-emerald-500" : pct >= 50 ? "bg-primary" : pct > 0 ? "bg-amber-500" : "bg-muted-foreground/30"
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
        <div className={cn("h-full rounded-full", color)} style={{ width: `${pct}%` }} aria-hidden />
      </div>
      <span className="text-xs tabular-nums text-muted-foreground">{pct}%</span>
    </div>
  )
}
