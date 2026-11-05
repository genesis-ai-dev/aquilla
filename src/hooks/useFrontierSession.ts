import { readSignupAnalyticsChoice, clearSignupAnalyticsChoice } from "@/lib/signup-analytics-choice"
import { confirmNewAccountAnalytics } from "@/lib/analytics-account"
import { toast } from "@/components/ui/toast"
import { t } from "@/lib/i18n/standalone"
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

export function useFrontierSession() {
  const { active, loading, loadError, retryLoad, adopt, removeAll } = useAccounts()

  const login = useCallback(async (
    username: string,
    password: string,
    options?: LoginOptions,
  ) => {
    const session = await doLogin({ username, password }, options)
    await adopt(session)
    clearSignupAnalyticsChoice()
    posthog.scope(undefined, session.username).capture("user logged in")
    return session
  }, [adopt])

  const register = useCallback(async (username: string, email: string, password: string) => {
    const choice = readSignupAnalyticsChoice()
    const session = await doRegister({ username, email, password })
    await adopt(session)
    if (choice && readSignupAnalyticsChoice()?.revision === choice.revision) {
      clearSignupAnalyticsChoice()
      try { await confirmNewAccountAnalytics(session.jwt, choice.allowed) }
      catch { toast.add({ type: "error", title: t("onboarding.privacy.saveFailed") }) }
    }
    posthog.scope(undefined, session.username).capture("user signed up")
    return session
  }, [adopt])

  const logout = useCallback(async () => {
    clearSignupAnalyticsChoice()
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
