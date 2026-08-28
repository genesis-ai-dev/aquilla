/**
 * AQU-995: keeps an actively-used session from lapsing on the 30-day timer.
 *
 * Mounted once at the app root. Each trigger is only a local `exp` decode —
 * `refreshActiveSession` no-ops without touching the network until the stored
 * token is actually past its half-life — so this is cheap to run often.
 *
 * Three triggers, because none of them covers the real cases alone:
 *  - mount, for the tab that was just opened;
 *  - visibility, for the long-lived tab that was backgrounded for days and is
 *    the classic way a session goes stale unnoticed (an interval in a throttled
 *    background tab is not reliable);
 *  - a slow interval, for the tab left open and visible for weeks, which never
 *    fires either of the other two.
 */

import { useEffect } from "react"
import { refreshActiveSession } from "@/lib/frontier/session-refresh"

/** Slow on purpose: the window to act in is days wide, not minutes. */
const CHECK_INTERVAL_MS = 60 * 60 * 1000

export function useSessionRefresh(): void {
  useEffect(() => {
    // Fire-and-forget throughout: refreshActiveSession never rejects, and a
    // refresh that doesn't happen is not a user-visible condition.
    void refreshActiveSession()

    const onVisible = () => {
      if (document.visibilityState === "visible") void refreshActiveSession()
    }
    document.addEventListener("visibilitychange", onVisible)
    const timer = setInterval(() => void refreshActiveSession(), CHECK_INTERVAL_MS)

    return () => {
      document.removeEventListener("visibilitychange", onVisible)
      clearInterval(timer)
    }
  }, [])
}
