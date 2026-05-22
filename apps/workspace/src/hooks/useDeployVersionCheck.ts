// Detects when the deployed workspace bundle has changed under the user's
// feet — typically because someone shipped to prod while their tab was
// open. The mechanism: HEAD the SPA shell on a poll + on tab-focus, and
// compare its ETag against the value observed on first check. Workers
// Assets sets the ETag to a content hash, so a deploy that changes ANY
// hashed chunk also bumps the index.html ETag (the html references every
// chunk by hash). A change means the loaded SPA is now out of date and
// will hit dead /w/assets/*.{js,css} URLs on its next lazy import.
//
// We deliberately capture the baseline from the FIRST HEAD response, not
// from the document that loaded the page — there's no in-page way to read
// the page's own ETag, and the first-poll baseline is good enough to catch
// every deploy that happens AFTER the page is loaded.

import { useEffect, useRef, useState } from "react"

const DEFAULT_ENDPOINT = "/w/index.html"
const DEFAULT_POLL_MS = 5 * 60_000

interface Options {
  /** Path to HEAD. Defaults to the workspace shell. */
  endpoint?: string
  /** Polling interval in ms. */
  pollMs?: number
}

export function useDeployVersionCheck(options?: Options): { stale: boolean } {
  const endpoint = options?.endpoint ?? DEFAULT_ENDPOINT
  const pollMs = options?.pollMs ?? DEFAULT_POLL_MS

  const baselineRef = useRef<string | null>(null)
  const [stale, setStale] = useState(false)

  useEffect(() => {
    if (typeof window === "undefined") return

    let cancelled = false

    async function check(): Promise<void> {
      try {
        const res = await fetch(endpoint, {
          method: "HEAD",
          cache: "no-store",
          credentials: "omit",
        })
        if (!res.ok) return
        const etag = res.headers.get("etag")
        if (!etag) return
        if (cancelled) return
        if (baselineRef.current === null) {
          baselineRef.current = etag
        } else if (baselineRef.current !== etag) {
          setStale(true)
        }
      } catch {
        // Network/HEAD failures are silent — the banner only fires on a
        // confirmed ETag mismatch, never on transient errors.
      }
    }

    check()
    const interval = window.setInterval(check, pollMs)

    function onVisibilityChange(): void {
      if (document.visibilityState === "visible") void check()
    }
    document.addEventListener("visibilitychange", onVisibilityChange)

    return () => {
      cancelled = true
      window.clearInterval(interval)
      document.removeEventListener("visibilitychange", onVisibilityChange)
    }
  }, [endpoint, pollMs])

  return { stale }
}
