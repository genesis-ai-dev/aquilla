"use client"

import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip"
import { cloneElement, useRef, useState } from "react"
import type { ReactElement, ReactNode } from "react"

import { cn } from "@/lib/utils"
import { Popover, PopoverContent } from "@/components/ui/popover"

type TooltipSide = "top" | "bottom" | "left" | "right"
type TooltipAlign = NonNullable<TooltipPrimitive.Positioner.Props["align"]>

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
  delay,
  disabled = false,
  className,
  disabledTriggerClassName,
}: {
  children: ReactElement
  content: ReactNode
  side?: TooltipSide
  align?: TooltipAlign
  /** Per-tooltip open delay. Leave unset to inherit the provider's: Base UI
   *  ≥1.8 lets a trigger's own delay win over its provider's (base-ui#5444),
   *  so a default here would silently override App.tsx's provider. */
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
  // clickable, not submittable) and let a wrapper span be the trigger. A click
  // lands on the wrapper, which the child cannot swallow precisely because it
  // has no pointer events, and `tabIndex={0}` gives keyboard users the same
  // sentence — a disabled button is not focusable, so without it they get
  // nothing.
  //
  // ⚠️ Testing this: happy-dom and jsdom DO dispatch pointer events on disabled
  // elements. Assert that the trigger is not itself `[disabled]`, and click
  // the stand-in, not the control.
  const childDisabled = (children.props as { disabled?: boolean }).disabled === true

  // AQU-2260 (Sam, Oct 29): a hover may only NAME an icon-only button; why a
  // control is greyed out is an explanation, so it opens on CLICK, in a small
  // note anchored to the control, and shuts on a second click or a click
  // outside. The stand-in span is still what takes the click and the focus
  // (Enter or Space opens the note); the child stays exactly as the caller
  // wrote it. Hovering a disabled control shows nothing.
  if (childDisabled) {
    return (
      <DisabledReason
        content={content}
        trigger={trigger}
        side={side}
        align={align}
        disabled={disabled}
        className={className}
        disabledTriggerClassName={disabledTriggerClassName}
      />
    )
  }

  return (
    <Tooltip disabled={disabled}>
      <TooltipTrigger render={trigger} delay={delay} />
      <TooltipContent side={side} align={align} className={className}>
        {content}
      </TooltipContent>
    </Tooltip>
  )
}

/**
 * A disabled control's reason, opened by a click (or Enter / Space) on its
 * stand-in, and shut by a second one or a click outside (AQU-2260). The
 * stand-in takes no role of its own, so the control inside keeps its name and
 * its disabled state for a screen reader; the note opens beside it.
 */
function DisabledReason({
  content, trigger, side, align, disabled, className, disabledTriggerClassName,
}: {
  content: ReactNode
  trigger: ReactElement
  side: TooltipSide
  align: TooltipAlign
  disabled: boolean
  className?: string
  disabledTriggerClassName?: string
}) {
  const [open, setOpen] = useState(false)
  const anchorRef = useRef<HTMLSpanElement>(null)
  const toggle = () => setOpen((o) => !o)
  return (
    <Popover
      open={open && !disabled}
      onOpenChange={(next, details) => {
        // A press on the stand-in itself is the toggle below; the popover's
        // own outside-press close must not race it.
        const target = details?.event?.target
        if (!next && target instanceof Node && anchorRef.current?.contains(target)) return
        setOpen(next)
      }}
    >
      <span
        ref={anchorRef}
        data-slot="tooltip-disabled-trigger"
        data-open={open ? "" : undefined}
        tabIndex={0}
        onClick={toggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault()
            toggle()
          }
        }}
        className={cn("inline-flex", disabledTriggerClassName)}
      >
        {trigger}
      </span>
      <PopoverContent
        anchor={anchorRef}
        side={side}
        align={align}
        sideOffset={6}
        data-slot="disabled-reason-note"
        className={cn("w-auto max-w-72 p-3 text-xs leading-relaxed", className)}
      >
        {content}
      </PopoverContent>
    </Popover>
  )
}

export { AppTooltip, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger }
