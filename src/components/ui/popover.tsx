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
      {/* z-50 has to live on the Positioner — see TooltipContent for the
          rationale. The Popup's z-index would otherwise be sealed inside
          the Positioner's transform-induced stacking context. Matches
          Dialog and Select (both z-50): a popover portal mounts after an
          already-open dialog's, so equal z-index resolves by document
          order and the popover stacks correctly above a parent dialog. */}
      <PopoverPrimitive.Positioner
        side={side}
        align={align}
        anchor={anchor}
        sideOffset={sideOffset}
        className="z-50"
      >
        <PopoverPrimitive.Popup
          data-slot="popover-content"
          className={cn(
            "rounded-2xl bg-popover text-popover-foreground shadow-soft-lg outline-none",
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
