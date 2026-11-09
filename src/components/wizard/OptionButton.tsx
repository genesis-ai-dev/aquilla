// One choice of a one-choice-per-step wizard: a full-width card with an icon,
// a title and a hint, plus an optional trailing slot (a health badge, say).
// Replaces the cramped "Import from LangQuest" button of AQU-2105 and gives
// the New-project source step and the LangQuest steps one look.

import type { ReactNode } from "react"
import { ChevronRight } from "lucide-react"
import { cn } from "@/lib/utils"

export interface OptionButtonProps {
  icon?: ReactNode
  title: ReactNode
  hint?: ReactNode
  trailing?: ReactNode
  onClick: () => void
  disabled?: boolean
  selected?: boolean
  className?: string
  "data-testid"?: string
}

export function OptionButton({ icon, title, hint, trailing, onClick, disabled, selected, className, ...rest }: OptionButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={selected}
      data-testid={rest["data-testid"]}
      className={cn(
        "flex w-full items-center gap-4 rounded-xl border bg-card px-4 py-3.5 text-left transition-colors",
        "hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
        "disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-card",
        selected && "border-primary bg-accent/40",
        className,
      )}
    >
      {icon && <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground [&>svg]:size-5">{icon}</span>}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-sm font-medium leading-tight">{title}</span>
        {hint && <span className="text-xs leading-snug text-muted-foreground">{hint}</span>}
      </span>
      {trailing ?? <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />}
    </button>
  )
}

/** The heading over a step's options. */
export function StepHeading({ title, hint }: { title: ReactNode; hint?: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <h3 className="text-base font-semibold leading-tight">{title}</h3>
      {hint && <p className="text-sm text-muted-foreground">{hint}</p>}
    </div>
  )
}
