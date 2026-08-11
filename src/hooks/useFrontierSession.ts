import { useCallback, useEffect } from "react"
import { useQueryClient } from "@tanstack/react-query"
import {
  login as doLogin,
  logout as doServerLogout,
  register as doRegister,
  type LoginOptions,
} from "@/lib/frontier/auth"
import { clearSession, clearAuthHint } from "@/lib/frontier/session-store"
import { clearAllLocalData } from "@/lib/store/project-index"
import { useAccounts } from "@/hooks/useAccounts"
import { purgeAudioCachesOnSignOut } from "@/lib/audio/cache-cleanup"
import posthog from "@/lib/posthog"
import { isAnalyticsEnabled } from "@/lib/analytics-consent"

/** Returns the hex SHA-256 of a string using Web Crypto (available in all modern browsers). */
async function sha256Hex(input: string): Promise<string> {
  const encoded = new TextEncoder().encode(input)
  const hashBuffer = await crypto.subtle.digest("SHA-256", encoded)
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

export function useFrontierSession() {
  const { active, loading } = useAccounts()
  const qc = useQueryClient()

  const login = useCallback(async (
    username: string,
    password: string,
    options?: LoginOptions,
  ) => {
    const session = await doLogin({ username, password }, options)
    const distinctId = await sha256Hex(session.username)
    posthog.identify(distinctId)
    posthog.capture("user logged in")
    return session
  }, [])

  const register = useCallback(async (username: string, email: string, password: string) => {
    const session = await doRegister({ username, email, password })
    const distinctId = await sha256Hex(session.username)
    const personProps = isAnalyticsEnabled() ? { email } : {}
    posthog.identify(distinctId, personProps)
    posthog.capture("user signed up")
    return session
  }, [])

  const logout = useCallback(async () => {
    posthog.capture("user logged out")
    posthog.reset()
    // Denylist the token server-side before dropping it locally, so a
    // leaked copy elsewhere doesn't stay valid until its natural expiry.
    // Best-effort — doServerLogout never throws.
    if (active?.jwt) await doServerLogout(active.jwt)
    await clearSession()
    await clearAllLocalData()
    await purgeAudioCachesOnSignOut()
    qc.clear()
  }, [qc, active])

  // Edge-case mitigation: if IDB is empty but aq_hint cookie was somehow
  // set (storage cleared, old cookie, first deploy), clear the hint so the
  // next cold visit to aquilla.app/ serves the homepage directly instead of
  // briefly flashing the empty app shell.
  useEffect(() => {
    if (!loading && active === null) {
      clearAuthHint()
    }
  }, [loading, active])

  return { session: active, loading, login, register, logout }
}
