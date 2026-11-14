import { useEffect } from "react"
import {
  TITLEBAR_BAND_HEIGHT,
  TRAFFIC_LIGHTS_WIDTH,
  useMacTitlebarOverlay,
  useTitlebarDrag,
} from "@/hooks/useMacTitlebarOverlay"

/**
 * macOS desktop only. Pages rendered outside AppShell (sign-in, invites, the
 * 404, …) have no header band, so they get a title-bar band of their own:
 * `html[data-mac-titlebar]` (index.css) pushes the page down by
 * TITLEBAR_BAND_HEIGHT (AppShell's header height), and this strip fills
 * that band as the drag handle.
 * Because the page starts below it, the strip never covers page controls and
 * nothing sits under the traffic lights.
 *
 * AppShell's own header takes over while it is mounted (index.css drops the
 * band and hides the strip under `html[data-app-frame]`). In native
 * fullscreen the lights are hidden and there is no window to drag, so the
 * band goes away too.
 */
export function TitlebarDragStrip() {
  const { inset } = useMacTitlebarOverlay()
  const drag = useTitlebarDrag(inset)

  useEffect(() => {
    if (!inset) return
    const root = document.documentElement
    root.dataset.macTitlebar = "true"
    root.style.setProperty("--mac-titlebar-h", `${TITLEBAR_BAND_HEIGHT}px`)
    // Read by `mac-titlebar-clear` (index.css) on the top-pinned banners.
    root.style.setProperty("--mac-traffic-lights-w", `${TRAFFIC_LIGHTS_WIDTH}px`)
    return () => {
      delete root.dataset.macTitlebar
      root.style.removeProperty("--mac-titlebar-h")
      root.style.removeProperty("--mac-traffic-lights-w")
    }
  }, [inset])

  if (!inset) return null
  return (
    <div
      data-slot="titlebar-drag-strip"
      aria-hidden
      {...drag}
      className="fixed inset-x-0 top-0 z-30 h-(--mac-titlebar-h)"
    />
  )
}
