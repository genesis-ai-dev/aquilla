// An (i) with no room around it for its text — a toolbar icon, a badge — opens
// a small note anchored to it on click, and closes it on a second click or a
// click anywhere outside (AQU-2260, Sam, Oct 29, Settings cleanup option 1A).
// NoteOnClick does the same for a badge or status mark that explains itself:
// the mark is the button.
// Never on hover: hover does nothing on touch, and a hover card floated over
// the controls around it. Where there IS room (settings pages, cards, dialogs,
// menus), use InfoToggle + InfoReveal from info-tip.tsx instead: the text opens
// in place under its title.

import type { ReactNode } from "react"
import { Info } from "lucide-react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"

export function InfoNote({
  label,
  children,
  testId,
  className,
  iconClassName,
  side = "bottom",
  align = "start",
}: {
  /** What the (i) explains, for screen readers. */
  label: string
  children: ReactNode
  testId?: string
  /** Classes for the (i) button (its colour, mostly). */
  className?: string
  iconClassName?: string
  side?: "top" | "bottom" | "left" | "right"
  align?: "start" | "center" | "end"
}) {
  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label={label}
            data-testid={testId}
            className={cn(
              "inline-flex shrink-0 rounded-sm p-0.5 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 aria-expanded:text-foreground",
              className,
            )}
          />
        }
      >
        <Info className={cn("h-3.5 w-3.5", iconClassName)} aria-hidden="true" />
      </PopoverTrigger>
      <PopoverContent
        side={side}
        align={align}
        sideOffset={6}
        data-testid={testId ? `${testId}-note` : undefined}
        className="w-72 p-3 text-xs leading-relaxed"
      >
        {children}
      </PopoverContent>
    </Popover>
  )
}

/** The note's own look, shared with a disabled control's reason (AppTooltip). */
export const NOTE_CONTENT_CLASS = "w-auto max-w-72 p-3 text-xs leading-relaxed"

/**
 * A badge, a status mark or a short label that explains itself on click (AQU-2260,
 * Oct 29 second pass: hover may only NAME an icon-only button). The mark is
 * the button; its note opens anchored to it and closes on a second click or a
 * click outside. It used to be a hover tooltip.
 */
export function NoteOnClick({
  note,
  children,
  label,
  testId,
  className,
  side = "bottom",
  align = "center",
}: {
  note: ReactNode
  /** The mark itself (a badge, an icon, a short label). */
  children: ReactNode
  /** Accessible name when the mark's own text does not say enough. */
  label?: string
  testId?: string
  className?: string
  side?: "top" | "bottom" | "left" | "right"
  align?: "start" | "center" | "end"
}) {
  if (!note) return <>{children}</>
  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label={label}
            data-testid={testId}
            data-slot="note-on-click"
            className={cn(
              "inline-flex min-w-0 cursor-pointer items-center rounded-sm text-start outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
              className,
            )}
          />
        }
      >
        {children}
      </PopoverTrigger>
      <PopoverContent
        side={side}
        align={align}
        sideOffset={6}
        data-testid={testId ? `${testId}-note` : undefined}
        className={NOTE_CONTENT_CLASS}
      >
        {note}
      </PopoverContent>
    </Popover>
  )
}
