import { useCallback, useEffect } from "react"
import {
  login as doLogin,
  logout as doServerLogout,
  register as doRegister,
  type LoginOptions,
} from "@/lib/frontier/auth"
import { clearAuthHint } from "@/lib/frontier/session-store"
import { useAccounts } from "@/hooks/useAccounts"
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
  const { active, loading, loadError, retryLoad, adopt, removeAll } = useAccounts()

  const login = useCallback(async (
    username: string,
    password: string,
    options?: LoginOptions,
  ) => {
    const session = await doLogin({ username, password }, options)
    await adopt(session)
    const distinctId = await sha256Hex(session.username)
    posthog.identify(distinctId)
    posthog.capture("user logged in")
    return session
  }, [adopt])

  const register = useCallback(async (username: string, email: string, password: string) => {
    const session = await doRegister({ username, email, password })
    await adopt(session)
    const distinctId = await sha256Hex(session.username)
    const personProps = isAnalyticsEnabled() ? { email } : {}
    posthog.identify(distinctId, personProps)
    posthog.capture("user signed up")
    return session
  }, [adopt])

  const logout = useCallback(async () => {
    posthog.capture("user logged out")
    posthog.reset()
    // Denylist the token server-side before dropping it locally, so a
    // leaked copy elsewhere doesn't stay valid until its natural expiry.
    // Best-effort — doServerLogout never throws.
    if (active?.jwt) await doServerLogout(active.jwt)
    await removeAll()
  }, [active, removeAll])

  // Edge-case mitigation: if IDB is empty but aq_hint remains set (storage
  // cleared or an old cookie), clear it so SPA entry/login guards do not treat
  // the next visit as an authenticated session.
  useEffect(() => {
    if (!loading && active === null) {
      clearAuthHint()
    }
  }, [loading, active])

  return {
    session: active,
    loading,
    sessionLoadError: loadError,
    retrySessionLoad: retryLoad,
    login,
    register,
    logout,
  }
}
