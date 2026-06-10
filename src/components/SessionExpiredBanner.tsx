/**
 * FRO-293: In-place session-expiry banner.
 *
 * Subscribes to the session-expired signal (src/lib/errors/session-expired-signal.ts).
 * When the signal fires (any fetch helper threw UserError(401)), shows a
 * fixed top banner with a direct link to /login?next=<current-path>.
 *
 * The banner is dismissible and resets on any navigation — it is not a
 * full-page takeover.
 */

import { useEffect, useState } from "react"
import { Link, useLocation } from "react-router-dom"
import { X } from "lucide-react"
import { onSessionExpired } from "@/lib/errors/session-expired-signal"

export function SessionExpiredBanner() {
  const [visible, setVisible] = useState(false)
  const location = useLocation()

  // Subscribe to session-expired signal
  useEffect(() => {
    return onSessionExpired(() => setVisible(true))
  }, [])

  // Clear banner on navigation (user went to /login themselves, or navigated away)
  useEffect(() => {
    setVisible(false)
  }, [location.pathname])

  if (!visible) return null

  const next = encodeURIComponent(location.pathname + location.search)

  return (
    <div
      role="alert"
      aria-live="assertive"
      className="fixed top-0 left-0 right-0 z-50 flex items-center justify-between gap-2 bg-amber-50 border-b border-amber-200 px-4 py-2 text-sm text-amber-900 dark:bg-amber-950/80 dark:border-amber-800 dark:text-amber-100"
    >
      <span>
        Your session expired.{" "}
        <Link
          to={`/login?next=${next}`}
          className="font-medium underline underline-offset-2 hover:text-amber-700 dark:hover:text-amber-300"
        >
          Sign in again
        </Link>{" "}
        to continue.
      </span>
      <button
        type="button"
        onClick={() => setVisible(false)}
        aria-label="Dismiss"
        className="shrink-0 rounded p-0.5 text-amber-700 hover:text-amber-900 dark:text-amber-400 dark:hover:text-amber-100"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  )
}
