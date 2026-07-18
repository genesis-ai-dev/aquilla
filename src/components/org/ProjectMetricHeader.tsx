import { ArrowDown, ArrowUp } from "lucide-react"
import type { LucideIcon } from "lucide-react"

import { AppTooltip } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

export function ProjectMetricHeader({
  label,
  description,
  icon: Icon,
  className,
  testId,
  sorted = false,
  onSort,
}: {
  label: string
  description: string
  icon: LucideIcon
  className?: string
  testId: string
  sorted?: false | "asc" | "desc"
  onSort?: (event: unknown) => void
}) {
  const SortIcon = sorted === "asc" ? ArrowUp : sorted === "desc" ? ArrowDown : null

  return (
    <AppTooltip content={description} delay={0}>
      <button
        type="button"
        aria-label={label}
        aria-sort={sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : "none"}
        data-testid={testId}
        onClick={(event) => onSort?.(event)}
        className={cn(
          "inline-flex h-7 min-w-7 items-center justify-start gap-1 justify-self-start rounded-sm text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50",
          className,
        )}
      >
        <Icon aria-hidden="true" className="size-4 shrink-0" strokeWidth={2} />
        {SortIcon ? <SortIcon aria-hidden="true" className="size-3 shrink-0" /> : null}
      </button>
    </AppTooltip>
  )
}
