import { Navigate, Link, useNavigate, useSearchParams } from "react-router-dom"
import { useState } from "react"
import { AuthPage, AuthPanel } from "@/components/auth/AuthPage"
import { CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { FrontierSignupForm } from "@/components/git-import/FrontierSignupForm"
import { FrontierLoginForm } from "@/components/git-import/FrontierLoginForm"
import { FrontierForgotPasswordForm } from "@/components/git-import/FrontierForgotPasswordForm"
import { SessionHydrationError } from "@/components/SessionHydrationError"
import { Spinner } from "@/components/ui/spinner"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { isJwtExpired } from "@/lib/frontier/auth"
import { billingSelectionPath, readBillingIntent } from "@/lib/billing/intent"
import { loginPath, safeLoginNext } from "@/lib/navigation/login-path"
import { useT } from "@/lib/i18n/I18nProvider"

/** Account creation is a single form. Workspace setup happens in the app. */
export function Signup() {
  const t = useT()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const { session, loading, sessionLoadError, retrySessionLoad } = useFrontierSession()
  const [mode, setMode] = useState<"signup" | "login" | "forgot">("signup")
  const [identifier, setIdentifier] = useState<string | null>(null)
  const billing = readBillingIntent(params)
  const next = billing.kind === "paid"
    ? billingSelectionPath(billing.selection)
    : safeLoginNext(params.get("next"))
  const complete = () => navigate(next, { replace: true })

  if (loading) return <div className="flex min-h-screen items-center justify-center"><Spinner /></div>
  if (sessionLoadError && !session) return <SessionHydrationError retry={retrySessionLoad} />
  if (session && !isJwtExpired(session.jwt)) return <Navigate to={next} replace />

  return <AuthPage><AuthPanel>
    <CardHeader><CardTitle role="heading" aria-level={1}>
      {t(mode === "signup" ? "nav.account.signupTitle" : mode === "login" ? "auth.login.title" : "auth.resetPassword.title")}
    </CardTitle></CardHeader>
    <CardContent className="flex flex-col gap-6">
      {billing.kind === "invalid" && <p role="alert">{t("onboarding.wizard.billingInvalid")}</p>}
      {mode === "signup" && <FrontierSignupForm onSuccess={complete} onSwitchToLogin={(value) => {
        setIdentifier(value)
        setMode("login")
      }} />}
      {mode === "login" && <FrontierLoginForm initialUsername={identifier} onSuccess={complete} onForgotPassword={() => setMode("forgot")} />}
      {mode === "forgot" && <FrontierForgotPasswordForm returnTo={next} onBack={() => setMode("login")} />}
      {mode === "signup" && <p className="text-center text-sm text-muted-foreground">
        {t("auth.join.alreadyHaveAccount")}{" "}<Link className="font-medium text-foreground hover:underline" to={loginPath({ next })}>{t("auth.login.submitDefault")}</Link>
      </p>}
    </CardContent>
  </AuthPanel></AuthPage>
}
