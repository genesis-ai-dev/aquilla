"use client"

import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip"
import { cloneElement } from "react"
import type { ReactElement, ReactNode } from "react"

import { cn } from "@/lib/utils"

type TooltipSide = "top" | "bottom" | "left" | "right"
type TooltipAlign = NonNullable<TooltipPrimitive.Positioner.Props["align"]>

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
  side = "bottom",
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
            "z-50 inline-flex w-fit max-w-xs origin-(--transform-origin) items-center gap-1.5 rounded-md border border-border bg-popover px-3 py-1.5 text-xs text-popover-foreground shadow-md has-data-[slot=kbd]:pe-1.5 **:data-[slot=kbd]:relative **:data-[slot=kbd]:isolate **:data-[slot=kbd]:z-50 **:data-[slot=kbd]:rounded-sm data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0 data-[state=delayed-open]:zoom-in-[0.97] data-open:animate-in data-open:fade-in-0 data-open:zoom-in-[0.97] data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-[0.97]",
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
  side = "bottom",
  align = "center",
  delay = DEFAULT_TOOLTIP_DELAY,
  disabled = false,
  className,
  disabledTriggerClassName,
}: {
  children: ReactElement
  content: ReactNode
  side?: TooltipSide
  align?: TooltipAlign
  delay?: number
  disabled?: boolean
  className?: string
  /** Layout classes for the stand-in trigger that wraps a natively-disabled
   *  child (see the note below). The wrapper defaults to `inline-flex`, which
   *  is right for an icon button; a child that sizes itself against its parent
   *  — `className="w-full"` — needs that width echoed here, or it collapses to
   *  the wrapper's shrink-to-fit width. */
  disabledTriggerClassName?: string
}) {
  // Empty content → no tooltip chrome. Keep the early return: callers that
  // pass no content never toggle it, so remounting the child is fine.
  if (!content) return children

  // Clear native `title` so the browser tooltip doesn't compete with ours.
  const trigger =
    typeof content === "string"
      ? cloneElement(children, { title: undefined } as Record<string, string | undefined>)
      : children

  // IMPORTANT: when `disabled` toggles (e.g. CreditsDial suppresses the
  // tooltip while its popover is open), keep the Tooltip tree mounted and
  // pass `disabled` through. Early-returning `children` remounts the trigger
  // — and if that trigger is a PopoverTrigger, the popover flashes at (0,0)
  // until the new anchor is measured.

  // AQU-959 — a natively-disabled child cannot be the trigger.
  //
  // Base UI binds the tooltip's hover/focus listeners to the trigger element
  // itself. A `disabled` element fires no pointer events at all in a real
  // browser (and `buttonVariants` additionally sets
  // `disabled:pointer-events-none`), so the explanation for WHY the control is
  // greyed out — the only thing the user actually needs — could never open. A
  // partner hit a silently dead "New voice" mid-demo and the call stalled until
  // the host changed her role by hand.
  //
  // So keep the child exactly as the caller wrote it (still `disabled`: not
  // clickable, not submittable) and let a wrapper span be the trigger. Hover
  // lands on the wrapper, which the child cannot swallow precisely because it
  // has no pointer events, and `tabIndex={0}` gives keyboard users the same
  // sentence — a disabled button is not focusable, so without it they get
  // nothing.
  //
  // ⚠️ Testing this: happy-dom and jsdom DO dispatch pointer events on disabled
  // elements, so hovering a disabled button opens the tooltip with or without
  // this wrapper. Assert that the trigger is not itself `[disabled]`; asserting
  // the hover is a false green.
  const childDisabled = (children.props as { disabled?: boolean }).disabled === true
  const triggerNode = childDisabled ? (
    <span
      data-slot="tooltip-disabled-trigger"
      tabIndex={0}
      className={cn("inline-flex", disabledTriggerClassName)}
    >
      {trigger}
    </span>
  ) : (
    trigger
  )

  return (
    <Tooltip disabled={disabled}>
      <TooltipTrigger render={triggerNode} delay={delay} />
      <TooltipContent side={side} align={align} className={className}>
        {content}
      </TooltipContent>
    </Tooltip>
  )
}

export { AppTooltip, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger }
