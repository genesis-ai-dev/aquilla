import { useCallback } from "react"
import { login as doLogin, register as doRegister } from "@/lib/frontier/auth"
import { clearSession } from "@/lib/frontier/session-store"
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

  return { session: active, loading, login, register, logout }
}
