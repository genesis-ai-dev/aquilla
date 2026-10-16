import { cn } from "@/lib/utils"
import { progressPercentOfFraction } from "@/lib/progress/progress-percent"
import { textProgressSegments } from "@/lib/progress/progress-palette"
import { ProgressSplitBar } from "@/components/progress/ProgressSplitBar"

/**
 * A slim validated-progress bar + percentage, in the shared progress palette
 * (AQU-1764, Sam 2026-10-13): validated in the dark blue and, where the caller
 * knows it, translated but not validated in the light blue after it. It used to
 * be a heat map (amber early, primary past half, emerald when done); the colour
 * now says what each part is and the length says how far, as on every other
 * progress bar.
 */
export function ValidatedBar({ fraction, translatedFraction, className }: {
  /** Validated, 0–1. */
  fraction: number
  /** Translated, 0–1. Omitted where the caller has no translated count (the admin tables). */
  translatedFraction?: number
  className?: string
}) {
  // AQU-1493: 100 only when every cell is validated — rounding let a project 1
  // of 1,208 short read as 100% beside the "99% Avg validated" tile above it on
  // the org Overview.
  const pct = progressPercentOfFraction(fraction)
  const translated = translatedFraction === undefined ? pct : progressPercentOfFraction(translatedFraction)
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <ProgressSplitBar
        segments={textProgressSegments({ validated: pct, translated, total: 100 })}
        height={6}
        className="w-16"
      />
      <span className="text-xs tabular-nums text-muted-foreground">{pct}%</span>
    </div>
  )
}
