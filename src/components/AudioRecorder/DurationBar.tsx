// Target-duration progress bar. Green while comfortably inside the target
// window, yellow in the last 500ms approaching the target, red past it.
// Used for subtitle cells that carry cue startTime/endTime. Cells without a
// target duration hit the elapsed-only fallback elsewhere.

import { cn } from "@/lib/utils"

interface Props {
  elapsedMs: number
  /** Target duration in seconds (endTime − startTime). */
  targetSec: number
  /** Extra headroom past the target shown before the bar pins to 100%. */
  overrunHeadroomSec?: number
  className?: string
}

function formatTime(ms: number): string {
  const totalMs = Math.max(0, Math.round(ms))
  const s = Math.floor(totalMs / 1000)
  const m = Math.floor(s / 60)
  const ss = String(s % 60).padStart(2, "0")
  const tenths = Math.floor((totalMs % 1000) / 100)
  return `${m}:${ss}.${tenths}`
}

export function DurationBar({ elapsedMs, targetSec, overrunHeadroomSec = 1.5, className }: Props) {
  const elapsedSec = elapsedMs / 1000
  const axisSec = targetSec + overrunHeadroomSec
  const pct = Math.min(100, (elapsedSec / axisSec) * 100)
  const targetPct = (targetSec / axisSec) * 100

  const state: "good" | "warn" | "over" =
    elapsedSec > targetSec
      ? "over"
      : elapsedSec > targetSec - 0.5
        ? "warn"
        : "good"

  const fillClass =
    state === "over" ? "bg-red-500" : state === "warn" ? "bg-amber-400" : "bg-emerald-500"

  return (
    <div className={cn("space-y-1", className)}>
      <div className="relative h-2 w-full overflow-hidden rounded-full bg-muted">
        {/* Target-window shading up to the target mark */}
        <div
          className="absolute inset-y-0 left-0 bg-emerald-500/10"
          style={{ width: `${targetPct}%` }}
        />
        {/* Fill */}
        <div
          className={cn("absolute inset-y-0 left-0 rounded-full transition-[width,background-color] duration-100 ease-out", fillClass)}
          style={{ width: `${pct}%` }}
        />
        {/* Target tick */}
        <div
          className="absolute inset-y-0 w-px bg-foreground/40"
          style={{ left: `${targetPct}%` }}
          aria-hidden="true"
        />
      </div>
      <div className="flex items-center justify-between text-xs tabular-nums text-muted-foreground">
        <span className={cn(state === "over" && "font-medium text-red-500")}>
          {formatTime(elapsedMs)}
        </span>
        <span>target {formatTime(targetSec * 1000)}</span>
      </div>
    </div>
  )
}
