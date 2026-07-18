// AQU-296: Explicit offline banner for the workspace shell.
//
// Shown whenever navigator.onLine is false. Listens for the browser's
// "online" / "offline" events to toggle visibility without a polling loop.
// The banner itself has no dismiss affordance — it clears automatically when
// the browser reports connectivity again.

import { useEffect, useState } from "react"
import { WifiOff } from "lucide-react"

/**
 * Full-width banner that appears when the browser is offline.
 * Mount this inside the workspace layout alongside the existing banner cluster
 * (writeError/stale-sibling region). It manages its own online/offline state
 * via browser events — no props required.
 */
export function OfflineBanner() {
  const [offline, setOffline] = useState(!navigator.onLine)

  useEffect(() => {
    function handleOnline() { setOffline(false) }
    function handleOffline() { setOffline(true) }
    window.addEventListener("online", handleOnline)
    window.addEventListener("offline", handleOffline)
    return () => {
      window.removeEventListener("online", handleOnline)
      window.removeEventListener("offline", handleOffline)
    }
  }, [])

  if (!offline) return null

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="offline-banner"
      className="flex w-full items-center gap-2 border-b border-slate-300 bg-slate-100 px-4 py-2 text-xs text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300"
    >
      <WifiOff className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <span>
        You&apos;re offline — changes are queued and will sync when you reconnect.
      </span>
    </div>
  )
}
