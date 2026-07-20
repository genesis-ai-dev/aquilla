"use client"

import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip"
import { cloneElement } from "react"
import type { ReactElement, ReactNode } from "react"

import { cn } from "@/lib/utils"

type TooltipSide = "top" | "bottom" | "left" | "right"

const DEFAULT_TOOLTIP_DELAY = 600

function TooltipProvider({
  delay = 0,
  ...props
}: TooltipPrimitive.Provider.Props) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delay={delay}
      {...props}
    />
  )
}

function Tooltip({ ...props }: TooltipPrimitive.Root.Props) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />
}

function TooltipTrigger({ ...props }: TooltipPrimitive.Trigger.Props) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />
}

function TooltipContent({
  className,
  side = "top",
  sideOffset = 4,
  align = "center",
  alignOffset = 0,
  children,
  ...props
}: TooltipPrimitive.Popup.Props &
  Pick<
    TooltipPrimitive.Positioner.Props,
    "align" | "alignOffset" | "side" | "sideOffset"
  >) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
        className="isolate z-50"
      >
        <TooltipPrimitive.Popup
          data-slot="tooltip-content"
          role="tooltip"
          className={cn(
            "z-50 inline-flex w-fit max-w-xs origin-(--transform-origin) items-center gap-1.5 rounded-md border border-border bg-popover px-3 py-1.5 text-xs text-popover-foreground shadow-md has-data-[slot=kbd]:pr-1.5 **:data-[slot=kbd]:relative **:data-[slot=kbd]:isolate **:data-[slot=kbd]:z-50 **:data-[slot=kbd]:rounded-sm data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0 data-[state=delayed-open]:zoom-in-[0.97] data-open:animate-in data-open:fade-in-0 data-open:zoom-in-[0.97] data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-[0.97]",
            className
          )}
          {...props}
        >
          {children}
        </TooltipPrimitive.Popup>
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  )
}

// Hover delay is owned by the single app-wide <TooltipProvider> (see App.tsx),
// so this wrapper no longer mounts its own provider — that keeps Base UI's
// delay-grouping working across adjacent tooltips instead of resetting per site.
function AppTooltip({
  children,
  content,
  side = "top",
  delay = DEFAULT_TOOLTIP_DELAY,
  disabled = false,
  className,
}: {
  children: ReactElement
  content: ReactNode
  side?: TooltipSide
  delay?: number
  disabled?: boolean
  className?: string
}) {
  if (disabled || !content) return children

  // Clear native `title` so the browser tooltip doesn't compete with ours.
  const trigger =
    typeof content === "string"
      ? cloneElement(children, { title: undefined } as Record<string, string | undefined>)
      : children

  return (
    <Tooltip>
      <TooltipTrigger render={trigger} delay={delay} />
      <TooltipContent side={side} className={className}>
        {content}
      </TooltipContent>
    </Tooltip>
  )
}

export { AppTooltip, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger }
