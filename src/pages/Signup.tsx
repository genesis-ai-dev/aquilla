import { Navigate, Link, useNavigate, useSearchParams } from "react-router-dom"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import { ChevronLeft } from "lucide-react"
import { VersionBadge } from "@/components/VersionBadge"
import { WelcomeStep } from "@/components/onboarding/steps/WelcomeStep"
import { PrivacyStep } from "@/components/onboarding/steps/PrivacyStep"
import { hasAnalyticsConsentBeenSet } from "@/lib/analytics-consent"

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

/** Welcome and privacy precede signup; workspace setup happens in the app. */
export function Signup() {
  const t = useT()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const { session, loading, sessionLoadError, retrySessionLoad } = useFrontierSession()
  const [mode, setMode] = useState<"signup" | "login" | "forgot">("signup")
  const [step, setStep] = useState<1 | 2 | 3>(1)
  const [visitedSignup, setVisitedSignup] = useState(false)
  const openSignup = () => { setVisitedSignup(true); setStep(3) }
  const [identifier, setIdentifier] = useState<string | null>(null)
  const billing = readBillingIntent(params)
  const next = billing.kind === "paid"
    ? billingSelectionPath(billing.selection)
    : safeLoginNext(params.get("next"))
  const complete = () => navigate(next, { replace: true })

  if (loading) return <div className="flex min-h-screen items-center justify-center"><Spinner /></div>
  if (sessionLoadError && !session) return <SessionHydrationError retry={retrySessionLoad} />
  if (session && !isJwtExpired(session.jwt)) return <Navigate to={next} replace />

  return <main className="flex min-h-svh flex-col bg-background p-4 sm:p-6">
    <div className="flex flex-1 items-center justify-center py-8"><div className="w-full max-w-md">
    <div className="mb-8 flex justify-center gap-2" aria-label={t("onboarding.wizard.stepProgress", { step, total: 3 })}>
      {[1, 2, 3].map(n => <span key={n} className={`size-2 rounded-full ${n <= step ? "bg-primary" : "bg-muted"}`} />)}
    </div>
    {step === 1 && <><WelcomeStep onNext={() => hasAnalyticsConsentBeenSet() ? openSignup() : setStep(2)} /><p className="mt-6 text-center text-sm"><Link to={loginPath({ next })}>{t("auth.join.alreadyHaveAccount")} {t("common.logIn")}</Link></p></>}
    {step === 2 && <PrivacyStep onNext={openSignup} onBack={() => setStep(1)} />}
    {visitedSignup && <div hidden={step !== 3}>
    <h1 className="mb-6 text-center text-2xl font-semibold">
      {t(mode === "signup" ? "nav.account.signupTitle" : mode === "login" ? "auth.login.title" : "auth.resetPassword.title")}
    </h1>
    <div className="flex flex-col gap-6">
      {billing.kind === "invalid" && <p role="alert">{t("onboarding.wizard.billingInvalid")}</p>}
      {mode === "signup" && <FrontierSignupForm onSuccess={complete} onSwitchToLogin={(value) => {
        setIdentifier(value)
        setMode("login")
      }} />}
      {mode === "login" && <FrontierLoginForm initialUsername={identifier} onSuccess={complete} onForgotPassword={() => setMode("forgot")} />}
      {mode === "forgot" && <FrontierForgotPasswordForm returnTo={next} onBack={() => setMode("login")} />}
      {mode === "signup" && <p className="text-center text-sm text-muted-foreground">
        {t("auth.join.alreadyHaveAccount")}{" "}<Link className="font-medium text-foreground hover:underline" to={loginPath({ next })}>{t("common.logIn")}</Link>
      </p>}
      {mode === "signup" && <Button variant="ghost" size="sm" onClick={() => setStep(2)} className="w-full"><ChevronLeft className="h-4 w-4 rtl:rotate-180" />{t("common.back")}</Button>}
    </div></div>}
    </div></div><footer className="w-full"><VersionBadge inline /></footer>
  </main>
}
