// Surfaces a one-time notice when OPFS is unavailable in the current browsing
// context (Safari Private Browsing, Brave Tor windows, locked-down profiles).
// The audio cache layer flips this state the first time
// `navigator.storage.getDirectory()` throws — the app keeps working but loses
// persistent caching for waveforms and LFS blobs, so each page load re-fetches
// and re-decodes from the network.

import { useState } from "react"
import { ShieldAlert, X } from "lucide-react"
import { useOpfsAvailability } from "@/hooks/useOpfsAvailability"

export function PrivateModeBanner() {
  const opfsAvailable = useOpfsAvailability()
  const [dismissed, setDismissed] = useState(false)

  if (opfsAvailable || dismissed) return null

  return (
    <div className="fixed top-0 left-0 right-0 z-30 flex items-center justify-center gap-2 border-b border-amber-200 bg-amber-50 px-3 py-1.5 text-xs text-amber-800 dark:border-amber-900/40 dark:bg-amber-950/40 dark:text-amber-200">
      <ShieldAlert className="h-3.5 w-3.5 shrink-0" />
      <span>
        Private browsing is restricting local storage. Audio will stream and play, but
        waveforms and downloads can't be cached — you'll see slower loads on each visit.
      </span>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        aria-label="Dismiss"
        className="ml-1 flex h-5 w-5 items-center justify-center rounded text-amber-700/70 transition-colors hover:bg-amber-100 hover:text-amber-900 dark:text-amber-300/70 dark:hover:bg-amber-900/40 dark:hover:text-amber-100"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  )
}
