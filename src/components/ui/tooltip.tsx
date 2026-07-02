import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip"
import { cloneElement, useCallback, useEffect, useRef, useState } from "react"
import type { CSSProperties, ReactElement, ReactNode } from "react"

import { cn } from "@/lib/utils"

type TooltipSide = "top" | "bottom" | "left" | "right"

const DEFAULT_TOOLTIP_DELAY = 300
const DELEGATED_TOOLTIP_OFFSET = 8

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
}: TooltipPrimitive.Popup.Props & { side?: TooltipSide }) {
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
        "pointer-events-none fixed z-[60] rounded-xl bg-popover px-3 py-1.5 text-xs text-popover-foreground shadow-soft outline-none",
        tooltip.className,
      )}
      style={tooltip.style}
    >
      {tooltip.content}
    </div>
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
  side?: TooltipSide
  delay?: number
  disabled?: boolean
  className?: string
}) {
  if (disabled || !content) return children
  const delegatedTooltipAttr = typeof content === "string" ? content : undefined
  if (delegatedTooltipAttr && typeof children.type === "string") {
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

export { AppTooltip, DelegatedTooltipLayer, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger }
