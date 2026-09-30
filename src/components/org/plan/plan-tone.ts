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
//
// AQU-1278 added Nearly complete as a SECOND RUNG OF THAT SAME AZURE rather
// than a new hue. Every hue on this board is already spoken for: amber means
// Due soon and emerald means Done, so a warm "almost there" would be read as a
// deadline and a green one as finished — a status it is not, which is the one
// mistake a status colour must never make. Nearly complete is not a different
// KIND of state from In progress either; it is further along the same one, so
// it reads as the same blue turned up.

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
  // AQU-1278. Hue 245 exactly as In progress uses it, one rung stronger: darker
  // and more saturated in light mode, deeper and more saturated in dark, and a
  // pill wash at twice the alpha. Beside In progress it reads as the same blue
  // with more in it, which is the claim — nearer the end of the same road.
  //
  // THE DARK RUNG STEPS DOWN IN LIGHTNESS, NOT UP, and that looks backwards
  // until you plot the hue: 245 peaks in chroma around L 0.70 and runs out of it
  // fast above L 0.80, where In progress already sits at 0.09 of a possible
  // 0.097. A lighter dark-mode rung could therefore only be FLATTER than In
  // progress, never stronger, so the strength is bought with saturation and the
  // lightness gives way. Both pairs sit at the edge of the sRGB gamut for this
  // hue; push either chroma further and the browser silently clips the blue
  // channel, which desaturates the very thing the rung exists to say.
  nearly_complete: {
    dot: "bg-[oklch(0.48_0.12_245)] dark:bg-[oklch(0.78_0.12_245)]",
    text: "text-[oklch(0.48_0.12_245)] dark:text-[oklch(0.78_0.12_245)]",
    bg: "bg-primary/20",
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
