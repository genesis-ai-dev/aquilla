import { useEffect, useState } from "react"
import { loadActiveSession } from "@/lib/frontier/session-store"

const DISMISS_KEY = "aq-appentry-dismissed"

function readDismissed(): boolean {
  try {
    return sessionStorage.getItem(DISMISS_KEY) === "1"
  } catch { return false }
}

/**
 * Strip offering a signed-in visitor a way into the workspace.
 *
 * `/` is the marketing homepage for everyone now — the Worker no longer branches
 * on a cookie (see worker/index.ts), which is what lets the page be edge-cached.
 * Identity is resolved here instead, in the browser, after the page has painted.
 *
 * Three properties this component has to keep:
 *
 *  - **Additive, never a mutation.** It appears alongside the existing calls to
 *    action rather than changing them. Rewriting "Sign up free" into "Open app"
 *    after a session check would flicker on every load; a strip that slides in
 *    doesn't.
 *  - **Renders null without a DOM.** The marketing pages are prerendered in Node
 *    at build time (scripts/prerender-marketing.ts). The effect never runs
 *    there, so the prerendered HTML has no banner and the cached page stays
 *    identical for every visitor.
 *  - **Presence, not validity.** A stored session is enough to show this, even
 *    an expired one. We can't validate a token here without a request, and
 *    guessing wrong in the cautious direction means hiding the way back into
 *    the app from someone who is actually signed in. /app re-checks auth
 *    normally and shows the login screen if the session turns out to be dead.
 */
export function AppEntryBanner() {
  const [username, setUsername] = useState<string | null>(null)
  const [dismissed, setDismissed] = useState<boolean>(readDismissed)

  useEffect(() => {
    let cancelled = false
    loadActiveSession()
      .then((session) => {
        if (!cancelled && session) setUsername(session.username)
      })
      .catch(() => {
        // No IndexedDB (private mode, storage disabled) — treat as signed out.
        // The nav's "Open app" link still works; this is an accelerator.
      })
    return () => { cancelled = true }
  }, [])

  if (!username || dismissed) return null

  const dismiss = () => {
    try { sessionStorage.setItem(DISMISS_KEY, "1") } catch { /* no storage */ }
    setDismissed(true)
  }

  return (
    <div className="aq-betabar aq-appentry" role="region" aria-label="Return to your workspace">
      <a className="aq-betabar-link" href="/app">
        <span className="aq-betabar-tag">Signed in</span>
        <span className="aq-betabar-text">
          Welcome back, {username} — open your workspace
        </span>
        <span className="aq-betabar-arrow" aria-hidden="true">→</span>
      </a>
      <button
        type="button"
        className="aq-betabar-close"
        onClick={dismiss}
        aria-label="Dismiss workspace shortcut"
      >
        <svg aria-hidden="true" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.7">
          <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  )
}
