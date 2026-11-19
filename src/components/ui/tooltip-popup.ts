import { cn } from "@/lib/utils"

/**
 * The tooltip's box. Click notes and disabled reasons share it
 * (`TOOLTIP_POPOVER_CLASS`) so they are the same size as a hover tooltip.
 */
export const TOOLTIP_POPUP_CLASS =
  "w-fit max-w-xs items-center gap-1.5 rounded-md border border-border bg-popover px-3 py-1.5 text-xs text-popover-foreground shadow-md ring-0"

/**
 * The same box on a PopoverContent. Its default `p-2.5` does not conflict
 * with `px-*` / `py-*` in tailwind-merge, so `p-0` drops it and the important
 * axes beat `p-0`. Without that, the note keeps the popover padding and draws
 * taller than a tooltip.
 */
export const TOOLTIP_POPOVER_CLASS = cn(TOOLTIP_POPUP_CLASS, "p-0 px-3! py-1.5!")
