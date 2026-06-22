import { useState } from "react"

const DISMISS_KEY = "aq-betabar-dismissed"

function readDismissed(): boolean {
  try {
    return sessionStorage.getItem(DISMISS_KEY) === "1"
  } catch { return false }
}

/**
 * Slim marketing strip above the homepage nav announcing the public beta and
 * linking to the /beta explainer page. Non-sticky — it scrolls away while the
 * nav stays pinned. Dismissal is remembered for the session (sessionStorage),
 * the same mechanism as the theme toggle.
 */
export function BetaBar() {
  const [dismissed, setDismissed] = useState<boolean>(readDismissed)
  if (dismissed) return null

  const dismiss = () => {
    try { sessionStorage.setItem(DISMISS_KEY, "1") } catch { /* no storage */ }
    setDismissed(true)
  }

  return (
    <div className="aq-betabar" role="region" aria-label="Public beta announcement">
      <a className="aq-betabar-link" href="/beta">
        <span className="aq-betabar-tag">Beta</span>
        <span className="aq-betabar-text">
          Aquilla is in public beta — see what's shipping and what's next
        </span>
        <span className="aq-betabar-arrow" aria-hidden="true">→</span>
      </a>
      <button
        type="button"
        className="aq-betabar-close"
        onClick={dismiss}
        aria-label="Dismiss beta announcement"
      >
        <svg aria-hidden="true" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.7">
          <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  )
}
