/**
 * useFlipAnimation — animate a list's reorders instead of letting it jump.
 *
 * FLIP (First, Last, Invert, Play): after every render, each child carrying
 * `data-flip-key` is measured; if it sat somewhere else last render, it is
 * snapped back there with a transform and then transitioned to its new place.
 * Children that are new this render fade and slide in.
 *
 * `data-flip-from` names the key an element *continues* — an approved rule
 * suggestion becomes a brand-new rule row with a new key, and pointing its
 * `data-flip-from` at the draft's key makes it glide from where the draft was.
 *
 * The list must be positioned (e.g. `relative`) so each row's `offsetTop` is
 * measured from it. Positions are layout offsets relative to the list, so neither page scroll
 * nor a transform from an animation still in flight is mistaken for movement
 * (measuring mid-animation with getBoundingClientRect feeds each re-render's
 * leftover transform into the next, and the rows twitch). Honors reduced
 * motion.
 */
import { useLayoutEffect, useRef, type RefObject } from "react"

const DURATION_MS = 260
const EASING = "cubic-bezier(0.2, 0, 0, 1)"

export function useFlipAnimation(listRef: RefObject<HTMLElement | null>) {
  const lastTops = useRef<Map<string, number>>(new Map())
  const mounted = useRef(false)

  // No dependency array: the list can reorder on any render, and measuring a
  // handful of rows is cheap next to the render that moved them.
  useLayoutEffect(() => {
    const list = listRef.current
    if (!list) return
    const items = Array.from(list.querySelectorAll<HTMLElement>(":scope > [data-flip-key]"))
    const nextTops = new Map<string, number>()
    for (const el of items) {
      nextTops.set(el.dataset.flipKey!, el.offsetTop)
    }

    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    // The first render is the page arriving, not the list changing.
    if (mounted.current && !reduceMotion) {
      for (const el of items) {
        const key = el.dataset.flipKey!
        const from = el.dataset.flipFrom
        const prevTop = lastTops.current.get(key) ?? (from ? lastTops.current.get(from) : undefined)
        const top = nextTops.get(key)!
        if (prevTop === undefined) {
          el.animate?.(
            [{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }],
            { duration: DURATION_MS, easing: EASING },
          )
        } else if (Math.abs(prevTop - top) > 0.5) {
          el.animate?.(
            [{ transform: `translateY(${prevTop - top}px)` }, { transform: "none" }],
            { duration: DURATION_MS, easing: EASING },
          )
        }
      }
    }
    mounted.current = true
    lastTops.current = nextTops
  })
}

