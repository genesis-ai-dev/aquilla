import { useEffect } from "react"
import { useNavigate } from "react-router-dom"
import { useAccounts } from "@/hooks/useAccounts"
import { isTauriRuntime } from "@/lib/offline/is-tauri"
import { isLaunchLandingPath, readLastWorkspace } from "@/lib/offline/last-workspace"
import { settleOfflineLaunchResume as settle } from "@/lib/offline/launch-resume"

/**
 * How long to wait for the first connectivity reading before giving up. Rust's
 * first probe lands within ~3.5s (250ms wait for the URL + a 3s request
 * timeout), and an online launch with an expired session waits on this before
 * going to sign-in, so don't hold it much past that.
 */
const FIRST_READING_TIMEOUT_MS = 5_000

// Once per page load: a user who goes back to the org page offline stays there.
let attempted = false

/**
 * Desktop: an app launched with no connection reopens the project the user last
 * had open, when its download is ready. The org page it would otherwise land on
 * is server-only, so offline it is a dead end.
 */
export function OfflineLaunchResume() {
  const { active } = useAccounts()
  const navigate = useNavigate()
  const username = active?.username ?? null

  useEffect(() => {
    if (attempted || !username || !isTauriRuntime()) return
    attempted = true
    if (!isLaunchLandingPath(window.location.pathname)) return settle(false)
    const last = readLastWorkspace(username)
    if (!last) return settle(false)

    void (async () => {
      const [{ desktopConnectivity }, { getOfflineStore }, { isProjectOfflineReady }] = await Promise.all([
        import("@/lib/offline/connectivity"),
        import("@/lib/offline/store"),
        import("@/lib/offline/offline-reads"),
      ])
      if ((await firstReading(desktopConnectivity)) !== false) return false
      const store = await getOfflineStore()
      if (!isProjectOfflineReady(store, last.projectId)) return false
      // The user may have moved on while the probe and store were coming up.
      if (!isLaunchLandingPath(window.location.pathname)) return false
      navigate(last.path, { replace: true })
      return true
    })().then(settle, (error) => {
      console.warn("[offline] couldn't reopen the last project", error)
      settle(false)
    })
  }, [username, navigate])

  return null
}

function firstReading(source: typeof import("@/lib/offline/connectivity").desktopConnectivity): Promise<boolean | null> {
  const now = source.current()
  if (now !== null) return Promise.resolve(now)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      unsubscribe()
      resolve(null)
    }, FIRST_READING_TIMEOUT_MS)
    const unsubscribe = source.subscribe((online) => {
      if (online === null) return
      clearTimeout(timer)
      unsubscribe()
      resolve(online)
    })
  })
}

