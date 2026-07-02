import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import type { AttentionReason } from "@/lib/admin/insights"

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

const REASON_VARIANT: Record<AttentionReason["kind"], "destructive" | "outline" | "secondary"> = {
  overdue: "destructive",
  soon: "outline",
  stalled: "secondary",
}

/** The set of "why this needs attention" chips for a project row. */
export function AttentionBadges({ reasons }: { reasons: AttentionReason[] }) {
  if (reasons.length === 0) return null
  return (
    <div className="flex flex-wrap gap-1">
      {reasons.map((r) => (
        <Badge key={r.kind} variant={REASON_VARIANT[r.kind]} className="text-[11px]">
          {r.label}
        </Badge>
      ))}
    </div>
  )
}
