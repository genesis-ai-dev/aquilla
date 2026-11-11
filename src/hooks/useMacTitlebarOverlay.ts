import { useEffect, useState } from "react"
import { isTauriRuntime } from "@/lib/offline/is-tauri"

/**
 * The desktop window (`src-tauri/tauri.conf.json`) uses macOS's overlay title
 * bar: no native title strip, the webview runs to the top edge, and the
 * traffic lights float over our top-left corner. Windows/Linux ignore those
 * settings and keep their native title bar, so this is macOS + Tauri only.
 *
 * `overlay`  — the web app owns the top strip: mark drag regions on it.
 * `inset`    — the traffic lights are on screen right now (they hide in
 *              native fullscreen), so the top-left must be kept clear.
 */
export interface MacTitlebarOverlay {
  overlay: boolean
  inset: boolean
}

/** Horizontal room the traffic lights take, from the window's left edge:
 *  `trafficLightPosition.x` (16) + the three buttons (~52) + breathing room. */
export const TRAFFIC_LIGHTS_WIDTH = 76

const isMac = (): boolean =>
  typeof navigator !== "undefined" && /Mac/i.test(navigator.userAgent)

export const isMacTitlebarOverlay = (): boolean => isTauriRuntime() && isMac()

export function useMacTitlebarOverlay(): MacTitlebarOverlay {
  const [overlay] = useState(isMacTitlebarOverlay)
  const [fullscreen, setFullscreen] = useState(false)

  useEffect(() => {
    if (!overlay) return
    let cancelled = false
    let unlisten: (() => void) | undefined
    // Dynamic import keeps @tauri-apps/api out of the browser bundle.
    void import("@tauri-apps/api/window").then(async ({ getCurrentWindow }) => {
      const win = getCurrentWindow()
      const sync = async () => {
        const fs = await win.isFullscreen()
        if (!cancelled) setFullscreen(fs)
      }
      await sync()
      // Entering/leaving native fullscreen always resizes the window.
      const off = await win.onResized(() => { void sync() })
      if (cancelled) off()
      else unlisten = off
    }).catch(() => {
      // Not fatal: worst case the inset stays applied in fullscreen.
    })
    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [overlay])

  return { overlay, inset: overlay && !fullscreen }
}
