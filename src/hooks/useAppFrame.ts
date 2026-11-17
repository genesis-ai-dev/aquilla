import { useLayoutEffect } from "react"

/**
 * `html[data-app-frame]`: AppShell's frame is on screen.
 *
 * The base stylesheet refuses a viewport scroll ONLY under it. Scoped rather
 * than global, and a page that is not in this frame is why: the in-app
 * privacy policy (removed in AQU-2243, now a 301 to /privacy) rendered a
 * 3,400px document straight into the body, and a blanket `overflow: hidden`
 * on html made two thirds of it unreachable — no wheel, no scrollbar, no End
 * key — including its own analytics opt-out. Login, the invite and verify
 * routes, the approval page and the 404 are all in the same position, and
 * three of them carry a comment saying they scroll the document by design,
 * so the scoping still earns its keep. Inside the frame the opposite holds:
 * every pane scrolls on its own, so a document scroll can only slide the
 * whole application off the top.
 *
 * On macOS desktop it also retires the title-bar band that pages outside the
 * frame get (index.css, TitlebarDragStrip), so the attribute must not blink:
 *  - every route mounts its own AppShell, so one route handing over to the
 *    next unmounts one frame and mounts another. Holders are counted and a
 *    release is settled a microtask later, after the commit's layout effects
 *    have run, so an AppShell → AppShell swap never drops it;
 *  - set in a layout effect, so the first painted frame already has it;
 *  - a lazy route's loading fallback sits between two AppShells while its
 *    chunk loads. It calls `useHoldAppFrame()`: it keeps a frame that is
 *    already up, but never raises one (a fallback before the sign-in page
 *    must not drop that page's band).
 */
let frames = 0
let holds = 0
let settleQueued = false

function apply(): void {
  const root = document.documentElement
  if (frames > 0) root.dataset.appFrame = "true"
  else if (holds === 0) delete root.dataset.appFrame
}

function settleSoon(): void {
  if (settleQueued) return
  settleQueued = true
  queueMicrotask(() => {
    settleQueued = false
    apply()
  })
}

export function useAppFrame(): void {
  useLayoutEffect(() => {
    frames++
    apply()
    return () => {
      frames--
      settleSoon()
    }
  }, [])
}

export function useHoldAppFrame(): void {
  useLayoutEffect(() => {
    holds++
    return () => {
      holds--
      settleSoon()
    }
  }, [])
}
