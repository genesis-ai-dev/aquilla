import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip"
import { cloneElement } from "react"
import type { ReactElement, ReactNode } from "react"

import { cn } from "@/lib/utils"

function TooltipProvider({ children, delay = 300, ...props }: TooltipPrimitive.Provider.Props) {
  return (
    <TooltipPrimitive.Provider delay={delay} {...props}>
      {children}
    </TooltipPrimitive.Provider>
  )
}

function Tooltip({ ...props }: TooltipPrimitive.Root.Props) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />
}

function TooltipTrigger({ render, ...props }: TooltipPrimitive.Trigger.Props) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" render={render} {...props} />
}

function TooltipContent({
  className,
  side = "top",
  ...props
}: TooltipPrimitive.Popup.Props & { side?: "top" | "bottom" | "left" | "right" }) {
  return (
    <TooltipPrimitive.Portal>
      {/* z-index lives on the Positioner, not the Popup: Base UI's Positioner
          uses `transform` for placement, which establishes a stacking context
          that seals any z-index on the Popup. z-[60] keeps tooltips above
          dialog content (z-50) and the editor table's sticky header (z-10). */}
      <TooltipPrimitive.Positioner side={side} className="z-[60]">
        <TooltipPrimitive.Popup
          data-slot="tooltip-content"
          className={cn(
            "rounded-xl bg-popover px-3 py-1.5 text-xs text-popover-foreground shadow-soft outline-none",
            className
          )}
          {...props}
        />
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  )
}

function AppTooltip({
  children,
  content,
  side = "top",
  delay = 300,
  disabled = false,
  className,
}: {
  children: ReactElement
  content: ReactNode
  side?: "top" | "bottom" | "left" | "right"
  delay?: number
  disabled?: boolean
  className?: string
}) {
  if (disabled || !content) return children
  const testTooltipAttr =
    import.meta.env.MODE === "test" && typeof content === "string"
      ? content
      : undefined
  const trigger =
    typeof content === "string"
      ? cloneElement(children, { "data-tooltip": testTooltipAttr, title: undefined } as Record<string, string | undefined>)
      : children

  return (
    <TooltipProvider delay={delay}>
      <Tooltip>
        <TooltipTrigger render={trigger} />
        <TooltipContent side={side} className={className}>
          {content}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

export { AppTooltip, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger }
