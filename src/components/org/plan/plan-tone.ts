// AQU-1092…1098: one colour per status, defined once.
//
// The board says a unit's status in three places — the group header, the pill
// in the inspector, and the date when it is overdue — and they have to agree.
// Colour NEVER carries the meaning alone: every use sits beside the word, so
// the board survives a greyscale print and a colour-blind reader.
//
// In progress uses a deeper blue than the app's --primary. Primary is a pale
// accent tuned for button fills; as text on a muted header it falls below a
// comfortable contrast, so the text-weight blue is a deliberate step darker
// (and a step lighter in dark mode). It is the same hue the bars fill with.

import type { PlanUnitStatus } from "@/lib/plan/plan-status"

export interface PlanTone {
  /** Background for a filled dot. */
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
  in_progress: {
    dot: "bg-[oklch(0.52_0.11_245)] dark:bg-[oklch(0.82_0.09_245)]",
    text: "text-[oklch(0.52_0.11_245)] dark:text-[oklch(0.82_0.09_245)]",
    bg: "bg-primary/10",
  },
  not_started: {
    dot: "bg-muted-foreground/50",
    text: "text-muted-foreground",
    bg: "bg-muted",
  },
}
