// Bible data, a popover that opens on hover AND on keyboard focus (AQU-1687;
// shared since AQU-1689 by the voice chip and the Who's Who mention words).
//
// Hover is never the only way in: keyboard focus opens the same popover.
// Opened by focus, focus stays on the trigger and Tab moves into the popover;
// it closes when focus moves on anywhere else. Opened by a press, focus moves
// in, as a menu's would. A click focuses the trigger too, so a press must not
// count as "opened by focus".
//
// Nothing returned is a ref object (the trigger takes a callback ref), so a
// component can read every field during render.

import { useCallback, useId, useRef, useState, type FocusEvent } from "react"

export interface HoverFocusPopover {
  open: boolean
  /** For Popover's onOpenChange: hover, Escape, an outside press. */
  onOpenChange: (next: boolean) => void
  /** Put on the element inside the popover content; it finds its popup by this id. */
  contentId: string
  triggerProps: {
    ref: (element: HTMLElement | null) => void
    onPointerDown: () => void
    onFocus: () => void
    onBlur: (event: FocusEvent<HTMLElement>) => void
  }
  contentProps: {
    initialFocus: () => boolean
    onBlur: (event: FocusEvent<HTMLElement>) => void
  }
}

export function useHoverFocusPopover(): HoverFocusPopover {
  const [open, setOpen] = useState(false)
  const pointerDownRef = useRef(false)
  const openedByFocusRef = useRef(false)
  const triggerRef = useRef<HTMLElement | null>(null)
  const contentId = useId()

  const setTrigger = useCallback((element: HTMLElement | null) => {
    triggerRef.current = element
  }, [])

  const onOpenChange = useCallback((next: boolean) => {
    openedByFocusRef.current = false
    setOpen(next)
  }, [])

  const onPointerDown = useCallback(() => {
    pointerDownRef.current = true
  }, [])

  const onFocus = useCallback(() => {
    if (!pointerDownRef.current) {
      openedByFocusRef.current = true
      setOpen(true)
    }
    pointerDownRef.current = false
  }, [])

  const onTriggerBlur = useCallback(
    (event: FocusEvent<HTMLElement>) => {
      // Opened by focus, so it closes when focus moves on, unless it moves
      // into the popover itself.
      const next = event.relatedTarget
      const popup = document.getElementById(contentId)?.closest('[data-slot="popover-content"]')
      const intoPopover = next instanceof Node && (popup?.contains(next) ?? false)
      if (openedByFocusRef.current && !intoPopover) {
        openedByFocusRef.current = false
        setOpen(false)
      }
    },
    [contentId],
  )

  // Opened by keyboard focus: keep focus on the trigger (Tab moves in).
  // Opened by a press: move focus in.
  const initialFocus = useCallback(() => !openedByFocusRef.current, [])

  const onContentBlur = useCallback((event: FocusEvent<HTMLElement>) => {
    // Focus left the popover for somewhere other than its trigger.
    const next = event.relatedTarget
    if (next instanceof Node && (event.currentTarget.contains(next) || triggerRef.current?.contains(next))) return
    openedByFocusRef.current = false
    setOpen(false)
  }, [])

  return {
    open,
    onOpenChange,
    contentId,
    triggerProps: { ref: setTrigger, onPointerDown, onFocus, onBlur: onTriggerBlur },
    contentProps: { initialFocus, onBlur: onContentBlur },
  }
}
