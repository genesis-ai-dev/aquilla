import { useEffect, useRef, useState } from "react"
import { Link, useNavigate } from "react-router-dom"
import { AuthPage, AuthPanel } from "@/components/auth/AuthPage"
import { CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { RevealableInput } from "@/components/ui/revealable-input"
import { PrivacyStep } from "@/components/onboarding/steps/PrivacyStep"
import { FrontierForgotPasswordForm } from "@/components/git-import/FrontierForgotPasswordForm"
import { Spinner } from "@/components/ui/spinner"
import { useT } from "@/lib/i18n/I18nProvider"
import { useAccounts } from "@/hooks/useAccounts"
import { googleReturn } from "@/lib/frontier/google-return"
import { clearGoogleAttempt, googleRequest, readGoogleAttempt, type GooglePending, type GoogleSession } from "@/lib/frontier/google-login"
import { finalizeSession } from "@/lib/frontier/auth"
import { clearSignupAnalyticsChoice, readSignupAnalyticsChoice } from "@/lib/signup-analytics-choice"
import { confirmNewAccountAnalytics } from "@/lib/analytics-account"
import { toast } from "@/components/ui/toast"
import { loginPath } from "@/lib/navigation/login-path"

export function GoogleLoginReturn() {
  const t = useT(), navigate = useNavigate(), { adopt } = useAccounts()
  const [attempt] = useState(readGoogleAttempt)
  const [choice, setChoice] = useState(attempt?.choice ?? null)
  const [pending, setPending] = useState<GooglePending | null>(null)
  const initialError = !attempt || !googleReturn?.get("code") || googleReturn?.get("error") ? (googleReturn?.get("error") === "cancelled" ? "cancelled" : "expired_request") : ""
  const [busy, setBusy] = useState(!initialError), [error, setError] = useState(initialError)
  const [recovering, setRecovering] = useState(false)
  const [username, setUsername] = useState(""), [password, setPassword] = useState("")
  const started = useRef(false)
  const finish = async (result: GoogleSession) => {
    const session = await finalizeSession(result.username, result)
    await adopt(session)
    // Approval belongs only to a newly created account from this signup attempt.
    // Signing into an existing account never borrows the provisional choice.
    if (result.created && choice && readSignupAnalyticsChoice()?.revision === choice.revision) {
      try { await confirmNewAccountAnalytics(session.jwt, choice.allowed) }
      catch { toast.add({ type: "error", title: t("onboarding.privacy.saveFailed") }) }
    }
    clearSignupAnalyticsChoice(); clearGoogleAttempt()
    navigate(attempt?.next ?? "/app", { replace: true })
  }
  useEffect(() => {
    if (started.current) return
    started.current = true
    const code = googleReturn?.get("code")
    if (!attempt || !code || googleReturn?.get("error")) {
      return
    }
    void googleRequest<GooglePending | GoogleSession>("exchange", { code, verifier: attempt.verifier })
      .then(async result => { if ("access_token" in result) await finish(result); else setPending(result) })
      .catch(err => setError(err instanceof Error ? err.message : "expired_request")).finally(() => setBusy(false))
    // One-time handoff must not be replayed by React StrictMode or re-renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return <AuthPage><AuthPanel>
    <CardHeader><CardTitle role="heading" aria-level={1}>{t(pending?.step === "signup" ? "auth.google.chooseUsername" : pending?.step === "link" ? "auth.google.linkTitle" : "auth.google.continue")}</CardTitle></CardHeader>
    <CardContent className="flex flex-col gap-4">
      {busy && <Spinner />}
      {error && <p role="alert" className="text-sm text-destructive">{t(error === "dev_access_restricted" ? "auth.login.devAccessRestricted" : error === "cancelled" ? "auth.google.cancelled" : error === "invalid_password" ? "auth.google.invalidPassword" : error === "identity_taken" ? "auth.google.identityTaken" : "auth.google.failed")}</p>}
      {recovering && <FrontierForgotPasswordForm onBack={() => setRecovering(false)} returnTo={attempt?.next} />}
      {pending?.step === "signup" && !choice && <PrivacyStep onNext={() => setChoice(readSignupAnalyticsChoice())} onBack={() => navigate(loginPath({ next: attempt?.next, add: true }))} />}
      {pending && !recovering && (pending.step !== "signup" || choice) && <form className="flex flex-col gap-4" onSubmit={event => {
        event.preventDefault(); if (!attempt || busy) return
        setBusy(true); setError("")
        void googleRequest<GoogleSession>("finish", { code: pending.continuation, verifier: attempt.verifier, ...(pending.step === "signup" ? { username } : { password }) })
          .then(finish).catch(err => setError(err instanceof Error ? err.message : "failed")).finally(() => { setPassword(""); setBusy(false) })
      }}>
        <p className="text-sm text-muted-foreground">{t(pending.step === "signup" ? "auth.google.usernameNote" : "auth.google.linkNote")}</p>
        <FieldGroup><Field><FieldLabel htmlFor="google-account">{t("common.email")}</FieldLabel><Input id="google-account" value={pending.email} readOnly /></Field>
        {pending.step === "signup" ? <Field><FieldLabel htmlFor="google-username">{t("auth.signup.usernameLabel")}</FieldLabel><Input id="google-username" required minLength={3} maxLength={50} autoComplete="username" value={username} onChange={e => setUsername(e.target.value)} /></Field>
          : <Field><FieldLabel htmlFor="google-password">{t("auth.google.passwordLabel")}</FieldLabel><RevealableInput id="google-password" required autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} /></Field>}
        </FieldGroup>
        <Button type="submit" disabled={busy}>{t(pending.step === "signup" ? "auth.signup.submitDefault" : "auth.google.linkSubmit")}</Button>
        {pending.step === "link" && <Button type="button" variant="link" onClick={() => setRecovering(true)}>{t("auth.login.forgotPasswordLink")}</Button>}
      </form>}
      <Link to={loginPath({ next: attempt?.next, add: true })} onClick={clearGoogleAttempt}>{t("auth.google.back")}</Link>
    </CardContent>
  </AuthPanel></AuthPage>
}
