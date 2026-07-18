import { cn } from "@/lib/utils"

/**
 * A slim validated-progress bar + percentage. Colour tracks completion so a
 * glance down a column reads as a heat map (red early → primary as it fills).
 */
export function ValidatedBar({ fraction, className }: { fraction: number; className?: string }) {
  const pct = Math.round(Math.max(0, Math.min(1, fraction)) * 100)
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
