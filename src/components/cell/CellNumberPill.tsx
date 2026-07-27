// The top-left number/label pill on a cell card. Shared by the translation
// editor (where it tints by issue severity and gets wrapped in an issues
// popover) and the Voice Studio (untinted line label), so both modes read the
// same.

import type { ReactNode } from "react"
import { cn } from "@/lib/utils"

export type CellPillTint = "none" | "issue" | "major"

export function CellNumberPill({
  number, label, tint = "none", plain = false, className, children,
}: {
  number?: string | number | null
  label?: string | null
  tint?: CellPillTint
  /** Drop the chip chrome (border + card background + padding) and render the
   *  number as a bare, muted line-number — subtler, for the editor gutter. The
   *  severity tint still tints the digit so the issue signal survives. */
  plain?: boolean
  className?: string
  children?: ReactNode
}) {
  if (number == null && !label && !children) return null
  const tintClass = tint === "major"
    ? "text-red-600 dark:text-red-400"
    : tint === "issue"
      ? "text-amber-600 dark:text-amber-400"
      : plain ? "text-muted-foreground/50" : "text-muted-foreground/70"
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-[10px] font-medium leading-none tabular-nums",
        !plain && "rounded-lg border border-border bg-card px-1.5 py-0.5",
        tintClass,
        className,
      )}
    >
      {number != null && <span>{number}</span>}
      {label && <span className="text-muted-foreground/80">{label}</span>}
      {children}
    </span>
  )
}
