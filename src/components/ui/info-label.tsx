// A label with an (i) beside it whose text opens in place, under the label, on
// click, and shuts on a second click (AQU-2260, Sam's rule for settings,
// cards, dialogs and menus). The InfoToggle / InfoReveal pair from
// info-tip.tsx, put together for the common case where the text sits right
// under the thing it explains.

import { useId, type ReactNode } from "react"
import { InfoReveal, InfoToggle, useInfoOpen } from "@/components/ui/info-tip"
import { cn } from "@/lib/utils"

export function InfoLabel({
  children,
  info,
  label,
  testId,
  className,
  rowClassName,
  revealClassName,
}: {
  /** The label (or the line) the (i) sits beside. */
  children: ReactNode
  /** What opens under it. */
  info: ReactNode
  /** The (i)'s accessible name: a few words saying what the text is about. */
  label: string
  /** Names the (i) `testId` and its text `${testId}-text`. */
  testId?: string
  className?: string
  rowClassName?: string
  revealClassName?: string
}) {
  const id = useId()
  const [open, toggle] = useInfoOpen()
  return (
    <div className={cn("flex min-w-0 flex-col", className)}>
      <span className={cn("flex min-w-0 items-center gap-1.5", rowClassName)}>
        {children}
        <InfoToggle open={open} onToggle={toggle} label={label} controls={id} testId={testId} />
      </span>
      <InfoReveal
        open={open}
        id={id}
        testId={testId ? `${testId}-text` : undefined}
        className={cn("text-xs font-normal text-muted-foreground", revealClassName)}
      >
        {info}
      </InfoReveal>
    </div>
  )
}
