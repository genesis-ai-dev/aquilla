// Surfaces a one-time notice when OPFS is unavailable in the current browsing
// context (Safari Private Browsing, Brave Tor windows, locked-down profiles).
// The audio cache layer flips this state the first time
// `navigator.storage.getDirectory()` throws — the app keeps working but loses
// persistent caching for waveforms and LFS blobs, so each page load re-fetches
// and re-decodes from the network.

import { useEffect, useMemo, useState } from "react"
import { ShieldAlert, X } from "lucide-react"
import { useOpfsAvailability } from "@/hooks/useOpfsAvailability"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { useT } from "@/lib/i18n/I18nProvider"

const DISMISS_KEY_PREFIX = "aq:private-mode-banner-dismissed:"
const memoryDismissals = new Set<string>()

function dismissalKey(username: string, createdAt: string): string {
  return `${DISMISS_KEY_PREFIX}${username}:${createdAt}`
}

function readDismissed(key: string): boolean {
  if (memoryDismissals.has(key)) return true
  try {
    return window.sessionStorage.getItem(key) === "1"
  } catch {
    return false
  }
}

function writeDismissed(key: string): void {
  memoryDismissals.add(key)
  try {
    window.sessionStorage.setItem(key, "1")
  } catch {
    // Storage may be restricted in exactly the contexts this banner explains.
  }
}

export function PrivateModeBanner() {
  const t = useT()
  const opfsAvailable = useOpfsAvailability()
  const { session, loading } = useFrontierSession()
  // Wait for a resolved login identity before considering display. Lazy route
  // transitions can briefly remount/re-render while account state settles; using
  // an anonymous fallback key there causes a one-frame banner flash.
  const sessionReady = !loading && Boolean(session?.username && session?.createdAt)
  const key = useMemo(
    () =>
      session?.username && session.createdAt
        ? dismissalKey(session.username, session.createdAt)
        : null,
    [session?.username, session?.createdAt],
  )
  const [dismissed, setDismissed] = useState(() => (key ? readDismissed(key) : true))

  useEffect(() => {
    setDismissed(key ? readDismissed(key) : true)
  }, [key])

  if (!sessionReady || !key || opfsAvailable || dismissed) return null

  function handleDismiss() {
    if (!key) return
    writeDismissed(key)
    setDismissed(true)
  }

  return (
    <div className="fixed top-0 left-0 right-0 z-40 flex items-center justify-center gap-2 border-b border-amber-200 bg-amber-50 px-3 py-1.5 text-xs text-amber-800 dark:border-amber-900/40 dark:bg-amber-950/40 dark:text-amber-200">
      <ShieldAlert className="h-3.5 w-3.5 shrink-0" />
      <span>{t("error.privateMode.message")}</span>
      <button
        type="button"
        onClick={handleDismiss}
        aria-label={t("common.dismiss")}
        className="ml-1 flex h-5 w-5 items-center justify-center rounded text-amber-700/70 transition-colors hover:bg-amber-100 hover:text-amber-900 dark:text-amber-300/70 dark:hover:bg-amber-900/40 dark:hover:text-amber-100"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  )
}
