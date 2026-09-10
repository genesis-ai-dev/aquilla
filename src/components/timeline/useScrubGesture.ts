// Dragging the playhead. (AQU-646 stage 5)
//
// Sam, 2026-08-26: "when the actual playhead is dragged around, it should scrub
// both the audio and the video if present" — and then, asked, ruled the audio
// half out: the picture moves, nothing sounds.
//
// THE HIT TARGET IS THE RULER, NOT THE PLAYHEAD, and that is not a compromise.
// The playhead is one pixel wide, `pointer-events-none`, and its `inset-y-0`
// spans the whole track stack — giving it pointer events would lay a live
// column over every chip in every lane, and its `left` is rewritten by a rAF
// sixty times a second while playing, so the target would move under the hand.
// The ruler is a 28px band that already owns click-to-seek.
//
// THE THRESHOLD IS WHERE THE GESTURE COMMITS, and everything about not breaking
// the existing click hangs off it. A press that never travels 3px is still a
// click: it seeks, and it does NOT stop playback, exactly as before. Only past
// the threshold does this take the transport.

import { useCallback, useEffect, useRef, useState } from "react"
import { SCRUB_INTENT_PX, scrubSecAt } from "@/lib/timeline/scrub"

export interface UseScrubGestureArgs {
  pxPerSec: number
  durationSec: number
  /** The gesture became a drag — take the transport. Fires once, at the
   *  threshold, never on a plain click. */
  onScrubStart?(): void
  /** The pointer moved. Coalesced to one call per frame. */
  onScrubMove(sec: number): void
  /** Released. The caller lands the final position through its ordinary seek. */
  onScrubEnd?(sec: number): void
  disabled?: boolean
}

export interface ScrubGesture {
  onPointerDown(e: React.PointerEvent<HTMLElement>): void
  /** True from the threshold to the release — the caller uses it to take the
   *  clock away from its transports for the duration. */
  scrubbing: boolean
  /**
   * Was the click that is about to arrive the tail of a drag?
   *
   * The browser fires `click` after a pointer sequence regardless, so without
   * this the surface would seek a second time on release. Consuming rather than
   * peeking, so the flag cannot outlive the gesture that set it — and the
   * ordinary click path is left completely untouched, which is what keeps this
   * element's shipped behaviour (and its tests) byte-identical.
   */
  consumeDragClick(): boolean
}

export function useScrubGesture(args: UseScrubGestureArgs): ScrubGesture {
  const [scrubbing, setScrubbing] = useState(false)
  // Every changing value the listeners need, behind one ref: the listeners are
  // installed once per gesture and would otherwise close over a stale zoom the
  // moment somebody pinched mid-drag.
  const live = useRef(args)
  // Refreshed in an effect rather than during render: a ref write in the render
  // body is what the refs lint objects to, and the listeners that read it are
  // only ever installed from a pointer event, which is after the effect.
  useEffect(() => { live.current = args })
  const frame = useRef<number | null>(null)
  const draggedRef = useRef(false)
  const cleanup = useRef<(() => void) | null>(null)
  useEffect(() => () => { cleanup.current?.() }, [])

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLElement>) => {
    if (live.current.disabled) return
    // The macOS ctrl-click trap every other drag in this timeline documents: it
    // is button 0 AND a context-menu press.
    if (e.button !== 0 || e.ctrlKey) return
    const surface = e.currentTarget
    const startX = e.clientX
    // Read the rect LIVE on every move, never captured here: this element is
    // sticky over a scroller, so a rect taken now goes stale the moment the
    // track moves under it.
    const secAt = (clientX: number) =>
      scrubSecAt({
        clientX,
        rectLeft: surface.getBoundingClientRect().left,
        pxPerSec: live.current.pxPerSec,
        durationSec: live.current.durationSec,
      })

    try { surface.setPointerCapture?.(e.pointerId) } catch { /* happy-dom */ }
    let moved = false
    let latest = secAt(startX)
    const restoreUserSelect = document.body.style.userSelect

    const stop = () => {
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", onUp)
      window.removeEventListener("pointercancel", onCancel)
      if (frame.current != null) { cancelAnimationFrame(frame.current); frame.current = null }
      document.body.style.userSelect = restoreUserSelect
      cleanup.current = null
      setScrubbing(false)
    }
    cleanup.current = stop

    const onMove = (ev: PointerEvent) => {
      latest = secAt(ev.clientX)
      if (!moved && Math.abs(ev.clientX - startX) > SCRUB_INTENT_PX) {
        moved = true
        document.body.style.userSelect = "none"
        setScrubbing(true)
        live.current.onScrubStart?.()
      }
      if (!moved) return
      // One update per frame. The pointer stream is 60-120Hz and hardware
      // dependent; a paint is not.
      if (frame.current != null) return
      frame.current = requestAnimationFrame(() => {
        frame.current = null
        live.current.onScrubMove(latest)
      })
    }
    const onUp = (ev: PointerEvent) => {
      const sec = secAt(ev.clientX)
      const wasDrag = moved
      stop()
      draggedRef.current = wasDrag
      if (wasDrag) live.current.onScrubEnd?.(sec)
    }
    // A CANCELLED DRAG COMMITS NOTHING. The pointer was taken away, so there is
    // no release position to read as intent — but the transport still has to be
    // handed back, which `onScrubEnd` at the last known position does.
    const onCancel = () => {
      const sec = latest
      const wasDrag = moved
      stop()
      if (wasDrag) live.current.onScrubEnd?.(sec)
    }
    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", onUp)
    window.addEventListener("pointercancel", onCancel)
  }, [])

  const consumeDragClick = useCallback(() => {
    const was = draggedRef.current
    draggedRef.current = false
    return was
  }, [])

  return { onPointerDown, scrubbing, consumeDragClick }
}
