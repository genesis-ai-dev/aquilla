// An (i) that opens a setting's longer explanation in place, beneath its title,
// and closes it again (Sam, Oct 28: "they should not be hovers, they should be
// buttons that you click and the text expands beneath them and retracts when
// clicked again"). The screen keeps only the short label until someone asks.
//
// InfoToggle is the button; InfoReveal is the text it opens, always drawn so it
// can open and close smoothly (the same grid-rows move as the Team card's
// "Visibility adjusted" note), hidden from reading and from Tab while shut.
// Both render spans, so they can sit inside a button such as a choice card.

import { Info } from "lucide-react"
import { useState, type MouseEvent, type ReactNode } from "react"
import { cn } from "@/lib/utils"

/** Open/closed state for one (i) and the text it reveals. */
export function useInfoOpen(): [boolean, () => void] {
  const [open, setOpen] = useState(false)
  return [open, () => setOpen((o) => !o)]
}

export function InfoToggle({ open, onToggle, label, controls, testId }: {
  open: boolean
  onToggle: () => void
  /** What the (i) explains, for screen readers. */
  label: string
  /** The id(s) of the InfoReveal(s) it opens. */
  controls: string
  testId?: string
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-expanded={open}
      aria-controls={controls}
      data-testid={testId}
      onClick={(e: MouseEvent) => {
        // Inside a label or a choice card, the (i) only opens its text.
        e.preventDefault()
        e.stopPropagation()
        onToggle()
      }}
      className={cn(
        "inline-flex shrink-0 rounded-sm p-0.5 hover:text-foreground",
        open ? "text-foreground" : "text-muted-foreground",
      )}
    >
      <Info className="h-3.5 w-3.5" aria-hidden="true" />
    </button>
  )
}

export function InfoReveal({ open, id, children, className, testId }: {
  open: boolean
  id: string
  children: ReactNode
  className?: string
  testId?: string
}) {
  return (
    <span
      id={id}
      data-testid={testId}
      data-open={open ? "true" : "false"}
      className={cn(
        "grid transition-[grid-template-rows,opacity,margin] duration-200 ease-out motion-reduce:transition-none",
        open ? "mt-1 grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
        className,
      )}
      aria-hidden={!open}
      inert={!open || undefined}
    >
      <span className="min-h-0 overflow-hidden">{children}</span>
    </span>
  )
}
