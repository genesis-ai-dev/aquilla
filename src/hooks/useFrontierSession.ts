import { useCallback, useEffect } from "react"
import { login as doLogin, register as doRegister } from "@/lib/frontier/auth"
import { clearSession, clearAuthHint } from "@/lib/frontier/session-store"
import { clearAllLocalData } from "@/lib/store/project-index"
import { useAccounts } from "@/hooks/useAccounts"
import { purgeAudioCachesOnSignOut } from "@/lib/audio/cache-cleanup"
import posthog from "@/lib/posthog"

export function useFrontierSession() {
  const { active, loading } = useAccounts()

  const login = useCallback(async (username: string, password: string) => {
    const session = await doLogin({ username, password })
    posthog.identify(session.username, { username: session.username })
    posthog.capture("user logged in", { username: session.username })
    return session
  }, [])

  const register = useCallback(async (username: string, email: string, password: string) => {
    const session = await doRegister({ username, email, password })
    posthog.identify(session.username, { username: session.username, email })
    posthog.capture("user signed up", { username: session.username })
    return session
  }, [])

  const logout = useCallback(async () => {
    posthog.capture("user logged out")
    posthog.reset()
    await clearSession()
    await clearAllLocalData()
    await purgeAudioCachesOnSignOut()
  }, [])

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
