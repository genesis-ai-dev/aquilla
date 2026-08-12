/**
 * AQU-293: In-place session-expiry banner.
 *
 * Subscribes to the session-expired signal (src/lib/errors/session-expired-signal.ts).
 * When the signal fires (any fetch helper threw UserError(401)), shows a
 * fixed top banner with a direct link to /login?next=<current-path>.
 *
 * AQU-884: the banner persists across navigation. It used to clear itself on
 * every `location.pathname` change, which meant the boot redirect (`/` →
 * `/orgs/all`) wiped it in the same tick it appeared — a user reloading with an
 * expired session landed on an empty dashboard with no explanation. It now
 * mirrors the latched flag in the signal module: visible from the first 401
 * until the user dismisses it or re-authenticates. It is still a banner, not a
 * full-page takeover.
 */

import { useSyncExternalStore } from "react"
import { Link, useLocation } from "react-router-dom"
import { X } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  clearSessionExpired,
  isSessionExpired,
  onSessionExpired,
} from "@/lib/errors/session-expired-signal"
import { useT } from "@/lib/i18n/I18nProvider"

export function SessionExpiredBanner() {
  const t = useT()
  // The signal module is the store; reading it through useSyncExternalStore
  // means the first render already reflects a 401 that fired during boot,
  // before this component mounted.
  const visible = useSyncExternalStore(onSessionExpired, isSessionExpired)
  const location = useLocation()

  if (!visible) return null

  const next = encodeURIComponent(location.pathname + location.search)

  return (
    <div
      role="alert"
      aria-live="assertive"
      className="fixed top-0 left-0 right-0 z-50 flex items-center justify-between gap-2 bg-amber-50 border-b border-amber-200 px-4 py-2 text-sm text-amber-900 dark:bg-amber-950/80 dark:border-amber-800 dark:text-amber-100"
    >
      <span>
        {t("auth.sessionExpired.message")}{" "}
        <Link
          to={`/login?next=${next}`}
          className="font-medium underline underline-offset-2 hover:text-amber-700 dark:hover:text-amber-300"
        >
          {t("auth.sessionExpired.signInAgain")}
        </Link>{" "}
        {t("auth.sessionExpired.continueSuffix")}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        onClick={() => clearSessionExpired()}
        aria-label={t("common.dismiss")}
        className="shrink-0 text-amber-700 hover:text-amber-900 dark:text-amber-400 dark:hover:text-amber-100"
      >
        <X />
      </Button>
    </div>
  )
}
