// Surfaces a non-blocking banner when the deployed workspace bundle has
// changed while the tab was open. Without this, the loaded SPA keeps
// referencing the previous deploy's hashed asset filenames and will 404
// on its next lazy import.
//
// Dismissal is sticky for 24h via localStorage — long-lived sessions get
// reminded the next day if they haven't reloaded by then.

import { useEffect, useState } from "react"
import { RefreshCw, X } from "lucide-react"
import { useDeployVersionCheck } from "@/hooks/useDeployVersionCheck"

const DISMISS_KEY = "aquilla:deploy-update-dismissed-until"
const DISMISS_MS = 24 * 60 * 60 * 1000

function readDismissedUntil(): number {
  if (typeof window === "undefined") return 0
  try {
    const stored = window.localStorage.getItem(DISMISS_KEY)
    if (!stored) return 0
    const parsed = Number.parseInt(stored, 10)
    return Number.isFinite(parsed) ? parsed : 0
  } catch {
    return 0
  }
}

export function DeployUpdateBanner() {
  const { stale } = useDeployVersionCheck()
  const [dismissedUntil, setDismissedUntil] = useState(() => readDismissedUntil())

  // Re-read the dismissal timestamp when the tab regains focus so a
  // banner dismissed yesterday reappears today without needing a
  // re-render trigger from elsewhere.
  useEffect(() => {
    if (typeof window === "undefined") return
    function onVisible() {
      if (document.visibilityState === "visible") {
        setDismissedUntil(readDismissedUntil())
      }
    }
    document.addEventListener("visibilitychange", onVisible)
    return () => document.removeEventListener("visibilitychange", onVisible)
  }, [])

  if (!stale) return null
  if (Date.now() < dismissedUntil) return null

  function reload(): void {
    window.location.reload()
  }

  function dismiss(): void {
    const until = Date.now() + DISMISS_MS
    try {
      window.localStorage.setItem(DISMISS_KEY, String(until))
    } catch {
      // localStorage unavailable (private mode, quota) — fall back to
      // in-memory dismissal for this session only.
    }
    setDismissedUntil(until)
  }

  return (
    <div className="fixed top-0 left-0 right-0 z-40 flex items-center justify-center gap-2.5 border-b border-blue-200 bg-blue-50 px-3 py-1.5 text-xs text-blue-900 dark:border-blue-900/40 dark:bg-blue-950/40 dark:text-blue-100">
      <RefreshCw className="h-3.5 w-3.5 shrink-0" />
      <span>A new version of Aquilla is available.</span>
      <button
        type="button"
        onClick={reload}
        className="rounded bg-blue-600 px-2 py-0.5 text-[11px] font-medium text-white transition-colors hover:bg-blue-700"
      >
        Reload
      </button>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Remind me tomorrow"
        title="Remind me tomorrow"
        className="ml-1 flex h-5 w-5 items-center justify-center rounded text-blue-700/70 transition-colors hover:bg-blue-100 hover:text-blue-900 dark:text-blue-300/70 dark:hover:bg-blue-900/40 dark:hover:text-blue-100"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  )
}
