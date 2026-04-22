import * as React from "react"
import { Popover as PopoverPrimitive } from "@base-ui/react/popover"

import { cn } from "@/lib/utils"

function Popover({ ...props }: PopoverPrimitive.Root.Props) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />
}

function PopoverTrigger({ render, ...props }: PopoverPrimitive.Trigger.Props) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" render={render} {...props} />
}

function PopoverContent({
  className,
  side = "bottom",
  align = "start",
  ...props
}: PopoverPrimitive.Popup.Props & {
  side?: "top" | "bottom" | "left" | "right"
  align?: "start" | "center" | "end"
}) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Positioner side={side} align={align}>
        <PopoverPrimitive.Popup
          data-slot="popover-content"
          className={cn(
            "z-50 rounded-md bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-none",
            "data-closed:pointer-events-none data-closed:opacity-0",
            className
          )}
          {...props}
        />
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  )
}

export { Popover, PopoverContent, PopoverTrigger }
