import { useCallback } from "react"
import { login as doLogin } from "@/lib/frontier/auth"
import { clearSession } from "@/lib/frontier/session-store"
import { useAccounts } from "@/hooks/useAccounts"

export function useFrontierSession() {
  const { active, loading } = useAccounts()

  const login = useCallback(async (username: string, password: string) => {
    return doLogin({ username, password })
  }, [])

  const logout = useCallback(async () => {
    await clearSession()
  }, [])

  return { session: active, loading, login, logout }
}
