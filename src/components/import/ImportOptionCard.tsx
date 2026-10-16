/**
 * One choice in the Import dialog, drawn as a card: an icon, a short title
 * (with an optional hint and badge), and one line saying what choosing it
 * does. The whole card is the button.
 *
 * Shared by the landing's importer tiles and the "Is this a translation?"
 * answers (AQU-1365, Sam's PR 3 pass): three long buttons in a row wrapped
 * unevenly ("Import it as a separate file" alone on a second line), and a
 * button's label had no room to say what the choice would do. A card has
 * both, stacks cleanly at any width, and reads like the importer tiles the
 * person picked from a moment earlier.
 */

import type { ReactNode } from "react"
import { ChevronRight, type LucideIcon } from "lucide-react"
import { Card } from "@/components/ui/card"
import { AppTooltip } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

export interface ImportOptionCardProps {
  icon: LucideIcon
  title: string
  /** Lighter words after the title, e.g. "(1000+ Bibles)". */
  hint?: string
  /** Shown at the end of the title line, e.g. a "Beta" badge. */
  badge?: ReactNode
  /** One line: what choosing this does. */
  description: string
  onSelect: () => void
  disabled?: boolean
  /** Why it is disabled; shown as the card's tooltip. */
  disabledTooltip?: string
  /** A chevron at the end, for a card that moves straight on when chosen. */
  chevron?: boolean
  /** Marks the suggested choice among several. */
  emphasis?: boolean
  "data-testid"?: string
}

export function ImportOptionCard({
  icon: Icon,
  title,
  hint,
  badge,
  description,
  onSelect,
  disabled = false,
  disabledTooltip,
  chevron = false,
  emphasis = false,
  "data-testid": testId,
}: ImportOptionCardProps) {
  const select = () => {
    if (!disabled) onSelect()
  }
  const card = (
    <Card
      size="sm"
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled || undefined}
      data-testid={testId}
      data-tooltip={import.meta.env.MODE === "test" && disabled ? disabledTooltip : undefined}
      onClick={select}
      onKeyDown={(e) => {
        if (!disabled && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault()
          select()
        }
      }}
      className={cn(
        "gap-0 px-3",
        emphasis && "bg-primary/5 ring-primary/50",
        disabled
          ? "cursor-not-allowed opacity-55"
          : cn(
              "transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              emphasis ? "hover:bg-primary/10" : "hover:bg-muted/50",
            ),
      )}
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <Icon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="text-sm font-medium leading-tight">{title}</span>
            {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
            {badge && <span className="ml-auto shrink-0">{badge}</span>}
          </div>
          <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{description}</p>
        </div>
        {chevron && <ChevronRight className="mt-2 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
      </div>
    </Card>
  )

  if (!disabled || !disabledTooltip) return card
  return <AppTooltip content={disabledTooltip}>{card}</AppTooltip>
}
