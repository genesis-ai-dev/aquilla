// AQU-1764: the one progress bar every busy surface draws — the plan board,
// the sidebar's file rows, the language chips and tables, the org overview.
//
// One track per medium, split into the parts `textProgressSegments` /
// `audioProgressSegments` return: validated first, then done but not validated
// yet, then (text only) AI drafts nobody has validated. Each part is a solid
// tone from the shared progress palette, with a 2px gap between parts so two
// neighbouring blues read as two things rather than one smudge. Sam,
// 2026-10-13: "Layout A, softest".

import { cn } from "@/lib/utils"
import { PROGRESS_BG, type ProgressSegment } from "@/lib/progress/progress-palette"

/** Track heights, written out so Tailwind generates each. */
const HEIGHT = {
  4: "h-1",
  6: "h-1.5",
  8: "h-2",
} as const

export function ProgressSplitBar({ segments, height = 8, label, title, className }: {
  /** The parts, in drawing order; see `textProgressSegments` / `audioProgressSegments`. */
  segments: readonly ProgressSegment[]
  /** Track height in px. */
  height?: keyof typeof HEIGHT
  /**
   * What the bar says, as a sentence ("82% translated, 64% validated"). Makes
   * the bar an image with that name. Omit it where a parent already carries
   * the sentence (or prints the numbers beside the bar), and the bar is hidden
   * from assistive tech instead of being read twice.
   */
  label?: string
  /** Native hover text. Most surfaces print their numbers instead. */
  title?: string
  /** Width and placement, for example `w-16` or `flex-1`. */
  className?: string
}) {
  return (
    <span
      data-slot="progress-split-bar"
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      title={title}
      // Same track as every other bar in the app: muted, fully rounded,
      // clipping its parts to the rounded ends.
      className={cn("flex gap-0.5 overflow-hidden rounded-full bg-muted", HEIGHT[height], className)}
    >
      {segments.map((segment, index) => (
        <span
          key={segment.tone}
          data-progress-tone={segment.tone}
          // The last part rounds its far end, like the single-colour fills
          // elsewhere; the joins between parts stay square across the gap.
          className={cn(
            "h-full",
            PROGRESS_BG[segment.tone],
            index === segments.length - 1 && "rounded-e-full",
          )}
          style={{ width: `${segment.pct}%` }}
        />
      ))}
    </span>
  )
}
