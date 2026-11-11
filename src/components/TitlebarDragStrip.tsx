import { useMacTitlebarOverlay } from "@/hooks/useMacTitlebarOverlay"

/**
 * macOS desktop only. Pages rendered outside AppShell (sign-in, invites, the
 * 404, …) have no header band to grab, and with the overlay title bar the
 * window would otherwise have nothing to drag it by. This transparent strip
 * along the top edge stands in for the native title bar there; AppShell's own
 * header takes over while it is mounted (CSS hides this under
 * `html[data-app-frame]`).
 */
export function TitlebarDragStrip() {
  const { overlay } = useMacTitlebarOverlay()
  if (!overlay) return null
  return (
    <div
      data-slot="titlebar-drag-strip"
      data-tauri-drag-region
      aria-hidden
      className="fixed inset-x-0 top-0 z-30 h-7"
    />
  )
}
