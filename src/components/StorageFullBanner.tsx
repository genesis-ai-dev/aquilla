// Warns when this browser origin is nearly out of storage (AQU-1865).
//
// The cells cache holds itself to a byte budget and sheds snapshots rather than
// let an edit fail, so the app keeps working past this point — but it works
// slower (every file open refetches), and on a shared or nearly-full machine
// the user is the only one who can actually free the disk. Mirrors
// `PrivateModeBanner`: one line, dismissible per session.

import { useState } from "react"
import { HardDrive, X } from "lucide-react"
import { useStoragePressure } from "@/hooks/useStoragePressure"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { useT } from "@/lib/i18n/I18nProvider"

const DISMISS_KEY_PREFIX = "aq:storage-full-banner-dismissed:"
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
    // A full or restricted disk is exactly the context this banner explains.
  }
}

export function StorageFullBanner() {
  const t = useT()
  const nearlyFull = useStoragePressure()
  const { session, loading } = useFrontierSession()
  const sessionReady = !loading && Boolean(session?.username && session?.createdAt)
  const key = session?.username && session.createdAt
    ? dismissalKey(session.username, session.createdAt)
    : null
  // Dismissal is remembered by the session's key rather than as a bare boolean,
  // so switching account inside one tab re-arms the notice for the new identity
  // without an effect that re-reads storage on every render.
  const [dismissedKey, setDismissedKey] = useState<string | null>(null)

  if (!sessionReady || !key || !nearlyFull) return null
  if (dismissedKey === key || readDismissed(key)) return null

  function handleDismiss() {
    if (!key) return
    writeDismissed(key)
    setDismissedKey(key)
  }

  return (
    <div className="fixed top-0 start-0 end-0 z-40 flex items-center justify-center gap-2 border-b border-amber-200 bg-amber-50 px-3 py-1.5 text-xs text-amber-800 dark:border-amber-900/40 dark:bg-amber-950/40 dark:text-amber-200">
      <HardDrive className="h-3.5 w-3.5 shrink-0" />
      <span>{t("error.storageNearlyFull.message")}</span>
      <button
        type="button"
        onClick={handleDismiss}
        aria-label={t("common.dismiss")}
        className="ms-1 flex h-5 w-5 items-center justify-center rounded text-amber-700/70 transition-colors hover:bg-amber-100 hover:text-amber-900 dark:text-amber-300/70 dark:hover:bg-amber-900/40 dark:hover:text-amber-100"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  )
}
