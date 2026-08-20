import type { ReactNode } from "react"
import { ArrowRight, ArrowUpRight } from "lucide-react"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

/**
 * Compact GitHub-style permission hint: one line naming who can edit, and a
 * next-action control (open the privileged-members modal, or the permission
 * docs). Lives inside DisabledFieldTooltip so the explanation is on the
 * locked control, not a page-level banner.
 */
export function PermissionLockHint({
  title,
  onView,
  href,
  linkLabel,
}: {
  title: string
  onView?: () => void
  href?: string
  linkLabel: string
}) {
  const linkClass =
    "inline-flex items-center gap-0.5 text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
  const link = onView ? (
    <button type="button" className={linkClass} onClick={onView}>
      {linkLabel}
      <ArrowRight className="size-3" aria-hidden />
    </button>
  ) : href ? (
    <a href={href} target="_blank" rel="noopener noreferrer" className={linkClass}>
      {linkLabel}
      <ArrowUpRight className="size-3" aria-hidden />
    </a>
  ) : null

  return (
    <div className="flex flex-col items-start gap-1">
      <p className="font-medium text-popover-foreground">{title}</p>
      {link}
    </div>
  )
}

// Shows `tooltip` only when the wrapped field is disabled — pass-through
// otherwise. Wrapping editable inputs in TooltipTrigger broke typing because
// the trigger's pointer/focus behavior was racing the input's own focus
// management; rendering the children bare when editable sidesteps that
// entirely while keeping the disabled-reason hint where it's useful.
export function DisabledFieldTooltip({
  disabled,
  tooltip,
  children,
}: {
  disabled: boolean
  tooltip: ReactNode
  children: ReactNode
}) {
  if (!disabled || !tooltip) return <>{children}</>
  const rich = typeof tooltip !== "string"
  return (
    <Tooltip>
      <TooltipTrigger
        delay={200}
        closeOnClick={false}
        render={<span className="block" />}
      >
        {children}
      </TooltipTrigger>
      <TooltipContent
        side="bottom"
        align="start"
        className={cn(
          rich &&
            "inline-flex max-w-64 flex-col items-start gap-1 px-3 py-2 text-sm",
        )}
      >
        {tooltip}
      </TooltipContent>
    </Tooltip>
  )
}
