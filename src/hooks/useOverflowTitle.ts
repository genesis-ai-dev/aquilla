import { useCallback, useLayoutEffect, useRef, useState } from "react"

/**
 * AQU-1485: reveal a clipped label's full text as native hover text — and only
 * when it is actually clipped, so a label that already fits never grows a
 * pointless tooltip.
 *
 * Measures `scrollWidth` against `clientWidth` on the element the returned
 * `ref` is attached to, re-checking on resize. An element an ancestor has
 * hidden with `display: none` (the milestone trigger collapsed to its
 * icon-only state, say) reports 0×0: none of the label is readable there, so
 * that counts as clipped and keeps the hover text. Pass `recheckToken` when a
 * state change other than a resize can hide or reveal the element — a
 * `display: none` flip is not guaranteed to reach the ResizeObserver.
 */
export function useOverflowTitle(
  text: string,
  recheckToken?: unknown,
): { ref: (element: HTMLElement | null) => void; title: string | undefined } {
  const elementRef = useRef<HTMLElement | null>(null)
  const observerRef = useRef<ResizeObserver | null>(null)
  const [clipped, setClipped] = useState(false)

  const measure = useCallback(() => {
    const element = elementRef.current
    if (!element) return
    const hidden = element.clientWidth === 0 && element.scrollWidth === 0
    setClipped(hidden || element.scrollWidth > element.clientWidth + 1)
  }, [])

  const ref = useCallback(
    (element: HTMLElement | null) => {
      observerRef.current?.disconnect()
      observerRef.current = null
      elementRef.current = element
      if (!element) return
      measure()
      if (typeof ResizeObserver === "undefined") return
      const observer = new ResizeObserver(measure)
      observer.observe(element)
      observerRef.current = observer
    },
    [measure],
  )

  useLayoutEffect(() => {
    measure()
  }, [measure, recheckToken, text])

  return { ref, title: clipped ? text : undefined }
}
