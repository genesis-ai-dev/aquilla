// AQU-1092…1098: one colour per status, defined once.
//
// The board says a unit's status in three places — the group header, the pill
// in the inspector, and the date when it is overdue — and they have to agree.
// Colour NEVER carries the meaning alone: every use sits beside the word, so
// the board survives a greyscale print and a colour-blind reader.
//
// IN PROGRESS AND NEARLY COMPLETE HAVE NO COLOUR (AQU-1764, Sam 2026-10-13).
// Both were blue (Nearly complete a stronger rung of In progress's azure,
// AQU-1278), and blue is now the progress bars' colour, so a blue status on a
// row of blue bars read as part of the bars. They are told apart by their MARK
// instead, in the text colour on the muted wash: In progress is a hollow ring,
// Nearly complete the same ring half filled, further along the same road. Every
// other hue is still spoken for — amber is Due soon and emerald is Done — so a
// colour of their own would have claimed a status they do not have.

import type { PlanUnitStatus } from "@/lib/plan/plan-status"

export interface PlanTone {
  /**
   * The status mark: a filled dot, or for In progress and Nearly complete a
   * ring drawn with a border (half filled for Nearly complete). The caller sets
   * its size and `rounded-full`; with the border inside that box (Tailwind's
   * border-box), a ring is the same size as a dot.
   */
  dot: string
  /** Foreground for the status word. */
  text: string
  /** Wash behind a pill. */
  bg: string
}

// Written out in full, never interpolated: Tailwind scans source for literal
// class names, so a class assembled from a template literal is never generated.
export const PLAN_TONE: Record<PlanUnitStatus, PlanTone> = {
  done: {
    dot: "bg-emerald-500",
    text: "text-emerald-700 dark:text-emerald-400",
    bg: "bg-emerald-500/10",
  },
  overdue: {
    dot: "bg-destructive",
    text: "text-destructive",
    bg: "bg-destructive/10",
  },
  soon: {
    dot: "bg-amber-500",
    text: "text-amber-700 dark:text-amber-400",
    bg: "bg-amber-500/10",
  },
  // AQU-1764: In progress's ring with its left half filled in, both in the
  // text colour, so it reads as the same mark further along.
  nearly_complete: {
    dot: "border-[1.5px] border-foreground bg-[linear-gradient(90deg,var(--foreground)_50%,transparent_50%)]",
    text: "text-foreground",
    bg: "bg-muted",
  },
  // AQU-1764: a hollow ring in the text colour; begun, not finished.
  in_progress: {
    dot: "border-[1.5px] border-foreground",
    text: "text-foreground",
    bg: "bg-muted",
  },
  not_started: {
    dot: "bg-muted-foreground/50",
    text: "text-muted-foreground",
    bg: "bg-muted",
  },
}
