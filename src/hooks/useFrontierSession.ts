import { useCallback } from "react"
import { login as doLogin } from "@/lib/frontier/auth"
import { clearSession } from "@/lib/frontier/session-store"
import { useAccounts } from "@/hooks/useAccounts"
import { purgeAudioCachesOnSignOut } from "@/lib/audio/cache-cleanup"
import posthog, { getAnonymousId } from "@/lib/posthog"

export function useFrontierSession() {
  const { active, loading } = useAccounts()

  const login = useCallback(async (username: string, password: string) => {
    const session = await doLogin({ username, password })
    posthog.identify({ distinctId: session.username, properties: { username: session.username } })
    posthog.alias({ distinctId: session.username, alias: getAnonymousId() })
    posthog.capture({ distinctId: session.username, event: "user logged in", properties: { username: session.username } })
    return session
  }, [])

  const logout = useCallback(async () => {
    const username = active?.username
    if (username) {
      posthog.capture({ distinctId: username, event: "user logged out" })
    }
    await clearSession()
    await purgeAudioCachesOnSignOut()
  }, [active?.username])

  return { session: active, loading, login, logout }
}
