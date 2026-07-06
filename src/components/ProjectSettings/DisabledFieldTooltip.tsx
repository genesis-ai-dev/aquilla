import type { ReactNode } from "react"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"

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
  tooltip: string | null
  children: ReactNode
}) {
  if (!disabled || !tooltip) return <>{children}</>
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="block" />}>{children}</TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  )
}
