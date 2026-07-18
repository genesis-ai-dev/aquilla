"use client"

import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip"
import { cloneElement, createContext, useCallback, useContext, useEffect, useRef, useState } from "react"
import type { CSSProperties, ReactElement, ReactNode } from "react"

import { cn } from "@/lib/utils"

type TooltipSide = "top" | "bottom" | "left" | "right"

const DEFAULT_TOOLTIP_DELAY = 600
const DELEGATED_TOOLTIP_OFFSET = 8

// Delegation is a performance escape hatch, not the default. It trades the
// full Base UI tooltip (a portal + positioner + effects per instance) for a
// single document-level listener layer that renders one node on demand — worth
// it only in trees that mount many tooltips at once (e.g. the editor grid,
// which is one tooltip-bearing control per cell across hundreds of cells).
// Everywhere else, AppTooltip renders the normal Base UI tooltip so behaviour
// and styling stay uniform. Opt a subtree in by wrapping it in
// <TooltipDelegationBoundary>.
const TooltipDelegationContext = createContext(false)

// Turns on delegation for its subtree AND mounts the single shared renderer,
// so the document-level listeners exist only while a hot region is on screen.
// Use around one region at a time (the editor grid) — nesting/parallel
// boundaries would each mount their own layer.
function TooltipDelegationBoundary({ children }: { children: ReactNode }) {
  return (
    <TooltipDelegationContext.Provider value={true}>
      {children}
      <DelegatedTooltipLayer />
    </TooltipDelegationContext.Provider>
  )
}

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

type DelegatedTooltipState = {
  content: string
  side: TooltipSide
  className?: string
  style: CSSProperties
}

function findDelegatedTooltipTrigger(target: EventTarget | null) {
  if (!(target instanceof Element)) return null
  return target.closest<HTMLElement>("[data-tooltip][data-slot='tooltip-trigger']")
}

function readTooltipSide(side?: string): TooltipSide {
  return side === "bottom" || side === "left" || side === "right" ? side : "top"
}

function getDelegatedTooltipPosition(trigger: HTMLElement, side: TooltipSide): CSSProperties {
  const rect = trigger.getBoundingClientRect()
  if (side === "bottom") {
    return {
      left: rect.left + rect.width / 2,
      top: rect.bottom + DELEGATED_TOOLTIP_OFFSET,
      transform: "translate(-50%, 0)",
    }
  }
  if (side === "left") {
    return {
      left: rect.left - DELEGATED_TOOLTIP_OFFSET,
      top: rect.top + rect.height / 2,
      transform: "translate(-100%, -50%)",
    }
  }
  if (side === "right") {
    return {
      left: rect.right + DELEGATED_TOOLTIP_OFFSET,
      top: rect.top + rect.height / 2,
      transform: "translate(0, -50%)",
    }
  }
  return {
    left: rect.left + rect.width / 2,
    top: rect.top - DELEGATED_TOOLTIP_OFFSET,
    transform: "translate(-50%, -100%)",
  }
}

function readTooltipDelay(delay?: string) {
  const parsed = Number(delay ?? DEFAULT_TOOLTIP_DELAY)
  return Number.isFinite(parsed) ? parsed : DEFAULT_TOOLTIP_DELAY
}

function DelegatedTooltipLayer() {
  const [tooltip, setTooltip] = useState<DelegatedTooltipState | null>(null)
  const activeTriggerRef = useRef<HTMLElement | null>(null)
  const timerRef = useRef<number | null>(null)

  const clearTimer = useCallback(() => {
    if (timerRef.current === null) return
    window.clearTimeout(timerRef.current)
    timerRef.current = null
  }, [])

  const hide = useCallback(() => {
    activeTriggerRef.current = null
    clearTimer()
    setTooltip(null)
  }, [clearTimer])

  const show = useCallback((trigger: HTMLElement, immediate = false) => {
    const content = trigger.dataset.tooltip
    if (!content) return
    activeTriggerRef.current = trigger
    clearTimer()

    const side = readTooltipSide(trigger.dataset.tooltipSide)
    const delay = immediate ? 0 : readTooltipDelay(trigger.dataset.tooltipDelay)
    const reveal = () => {
      if (activeTriggerRef.current !== trigger) return
      setTooltip({
        content,
        side,
        className: trigger.dataset.tooltipClass,
        style: getDelegatedTooltipPosition(trigger, side),
      })
      timerRef.current = null
    }

    if (delay > 0) {
      timerRef.current = window.setTimeout(reveal, delay)
    } else {
      reveal()
    }
  }, [clearTimer])

  useEffect(() => {
    const handlePointerOver = (event: PointerEvent) => {
      const trigger = findDelegatedTooltipTrigger(event.target)
      if (!trigger || trigger === activeTriggerRef.current) return
      show(trigger)
    }

    const handlePointerOut = (event: PointerEvent) => {
      const trigger = activeTriggerRef.current
      if (!trigger) return
      const relatedTarget = event.relatedTarget
      if (relatedTarget instanceof Node && trigger.contains(relatedTarget)) return
      if (findDelegatedTooltipTrigger(event.target) === trigger) hide()
    }

    const handleFocusIn = (event: FocusEvent) => {
      const trigger = findDelegatedTooltipTrigger(event.target)
      if (trigger) show(trigger, true)
    }

    const handleFocusOut = (event: FocusEvent) => {
      const trigger = activeTriggerRef.current
      if (!trigger) return
      const relatedTarget = event.relatedTarget
      if (relatedTarget instanceof Node && trigger.contains(relatedTarget)) return
      hide()
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") hide()
    }

    document.addEventListener("pointerover", handlePointerOver)
    document.addEventListener("pointerout", handlePointerOut)
    document.addEventListener("focusin", handleFocusIn)
    document.addEventListener("focusout", handleFocusOut)
    document.addEventListener("keydown", handleKeyDown)
    window.addEventListener("scroll", hide, true)
    window.addEventListener("resize", hide)

    return () => {
      clearTimer()
      document.removeEventListener("pointerover", handlePointerOver)
      document.removeEventListener("pointerout", handlePointerOut)
      document.removeEventListener("focusin", handleFocusIn)
      document.removeEventListener("focusout", handleFocusOut)
      document.removeEventListener("keydown", handleKeyDown)
      window.removeEventListener("scroll", hide, true)
      window.removeEventListener("resize", hide)
    }
  }, [clearTimer, hide, show])

  if (!tooltip) return null

  return (
    <div
      data-slot="tooltip-content"
      data-side={tooltip.side}
      role="tooltip"
      className={cn(
        "pointer-events-none fixed z-60 max-w-xs rounded-md border border-border bg-popover px-3 py-1.5 text-xs text-popover-foreground shadow-md outline-none",
        tooltip.className,
      )}
      style={tooltip.style}
    >
      {tooltip.content}
    </div>
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
  const delegate = useContext(TooltipDelegationContext)
  if (disabled || !content) return children
  const delegatedTooltipAttr = typeof content === "string" ? content : undefined
  if (delegate && delegatedTooltipAttr && typeof children.type === "string") {
    return cloneElement(children, {
      "data-slot": "tooltip-trigger",
      "data-tooltip": delegatedTooltipAttr,
      "data-tooltip-side": side,
      "data-tooltip-delay": delay === DEFAULT_TOOLTIP_DELAY ? undefined : String(delay),
      "data-tooltip-class": className,
      title: undefined,
    } as Record<string, string | undefined>)
  }
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

export { AppTooltip, DelegatedTooltipLayer, TooltipDelegationBoundary, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger }
