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
  anchor,
  sideOffset,
  ...props
}: PopoverPrimitive.Popup.Props & {
  side?: "top" | "bottom" | "left" | "right"
  align?: "start" | "center" | "end"
  anchor?: PopoverPrimitive.Positioner.Props["anchor"]
  sideOffset?: PopoverPrimitive.Positioner.Props["sideOffset"]
}) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Positioner side={side} align={align} anchor={anchor} sideOffset={sideOffset}>
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
