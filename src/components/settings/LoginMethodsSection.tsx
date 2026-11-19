import { AccountSecurity, PasswordManagement } from "./AccountSecurity"
import { EmailChangeForm } from "./EmailChangeForm"
import { resolveBackendEnvironment } from "@/lib/deployment-environment"
import googleLogo from "@/assets/google-login/g-logo.png"
import { RefreshCw } from "lucide-react"
import { Spinner } from "@/components/ui/spinner"
import { notifySessionExpiredIfCurrent } from "@/lib/frontier/session-expiry"
import { useEffect, useRef, useState } from "react"
import { useAccounts } from "@/hooks/useAccounts"
import { useT } from "@/lib/i18n/I18nProvider"
import { Button } from "@/components/ui/button"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { RevealableInput } from "@/components/ui/revealable-input"
import { SettingsGroup, SettingsRow, SettingsBlock } from "@/components/ui/page"
import { googleRequest, startGoogleLogin } from "@/lib/frontier/google-login"
import { resendVerificationEmail } from "@/lib/frontier/auth"
import type { MessageKey } from "@/lib/i18n/messages/en"

export function LoginMethodsSection() {
  const { active } = useAccounts()
  return active ? (
    <AccountSecurity
      key={active.jwt}
      jwt={active.jwt}
      username={active.username}
    >
      <AccountLoginMethods jwt={active.jwt} username={active.username} />
    </AccountSecurity>
  ) : null
}
function AccountLoginMethods({
  jwt,
  username,
}: {
  jwt: string
  username: string
}) {
  const t = useT()
  const [offerBackup, setOfferBackup] = useState(true)
  const [changingEmail, setChangingEmail] = useState(false)
  const [methods, setMethods] = useState<{ email: string; password: boolean; email_verified: boolean; google: boolean; google_available: boolean } | null>(null)
  const [error, setError] = useState(false), [busy, setBusy] = useState(false)
  const previousPassword = useRef<boolean | null>(null)
  const [sessionExpired, setSessionExpired] = useState(false)
  const [refreshing, setRefreshing] = useState(true)
  const [disconnecting, setDisconnecting] = useState(false), [password, setPassword] = useState("")
  const [recovering, setRecovering] = useState(false), [revision, setRevision] = useState(0)
  // AQU-2636: the account's own verification status, and the one button that
  // can fix it. `notice` holds either the confirmation naming the address the
  // link went to, or the reason nothing was sent.
  const [verifying, setVerifying] = useState(false)
  const [notice, setNotice] = useState<{ text: string; failed: boolean } | null>(null)
  const sendVerificationLink = () => {
    if (verifying) return
    setVerifying(true); setNotice(null)
    void resendVerificationEmail(jwt)
      .then(email => {
        setNotice({ text: t("auth.verifyEmail.linkSent", { email }), failed: false })
        // The address may have been verified in another tab while this ran.
        setRevision(n => n + 1)
      })
      .catch(reason => {
        // The server answers with a stable code (already_verified,
        // rate_limited, email_delivery_unavailable); anything else is a
        // transport failure and gets the generic line.
        const code = reason instanceof Error ? reason.message : ""
        const known = ["already_verified", "rate_limited", "email_delivery_unavailable"]
        setNotice({
          text: t(known.includes(code) ? (`auth.verifyEmail.${code}` as MessageKey) : "auth.verifyEmail.sendFailed"),
          failed: true,
        })
        if (code === "already_verified") setRevision(n => n + 1)
      })
      .finally(() => setVerifying(false))
  }
  useEffect(() => {
    let current = true
    setRefreshing(true)
    setError(false)
    setSessionExpired(false)
    void googleRequest<NonNullable<typeof methods>>("methods", undefined, jwt)
      .then((value) => {
        if (!current) return
        if (previousPassword.current === false && value.password) setRecovering(false)
        // AQU-2636: returning from the emailed link refreshes this read, and
        // the row then says verified — so drop the "link sent" line rather
        // than leaving it under a status it has already outlived.
        if (value.email_verified) setNotice(null)
        previousPassword.current = value.password
        setMethods(value)
      })
      .catch((reason) => {
        if (!current) return
        const rejected =
          reason instanceof Error && reason.message === "session_expired"
        setError(true)
        setSessionExpired(rejected)
        if (rejected) void notifySessionExpiredIfCurrent(jwt)
      })
      .finally(() => {
        if (current) setRefreshing(false)
      })
    return () => {
      current = false
    }
  }, [jwt, revision])
  useEffect(() => {
    const refreshOnReturn = () => {
      if (document.visibilityState === "visible") setRevision((n) => n + 1)
    }
    window.addEventListener("focus", refreshOnReturn)
    document.addEventListener("visibilitychange", refreshOnReturn)
    return () => {
      window.removeEventListener("focus", refreshOnReturn)
      document.removeEventListener("visibilitychange", refreshOnReturn)
    }
  }, [])
  if (sessionExpired) return null // The shared recovery banner owns this state.
  return (
    <SettingsGroup>
      {error && (
        <SettingsBlock>
          <p role="alert" className="text-sm text-destructive">
            {t("auth.methods.failed")}
          </p>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setRevision((n) => n + 1)}
          >
            {t("auth.methods.refresh")}
          </Button>
        </SettingsBlock>
      )}
      {!methods && !error && (
        <SettingsBlock>
          <Spinner />
        </SettingsBlock>
      )}
      {methods && (
        <>
          {methods.google &&
            !methods.password &&
            offerBackup &&
            !recovering && (
              <SettingsBlock>
                <p className="font-medium">
                  {t("auth.security.addABackupPassword")}
                </p>
                <p>{t("auth.security.setAnAquillaPasswordSoYouCanStill")}</p>
                <div className="flex gap-2">
                  <Button onClick={() => setRecovering(true)}>
                    {t("auth.security.setAPassword")}
                  </Button>
                  <Button variant="ghost" onClick={() => setOfferBackup(false)}>
                    {t("auth.security.notNow")}
                  </Button>
                </div>
              </SettingsBlock>
            )}

          <SettingsRow
            label={methods.email}
            description={t("auth.emailChange.accountEmail")}
            control={
              <Button
                size="sm"
                variant="outline"
                disabled={refreshing || error}
                onClick={() => {
                  setRecovering(false)
                  setChangingEmail(true)
                }}
              >
                {t("auth.emailChange.action")}
              </Button>
            }
          />
        <SettingsRow
          className="flex-wrap items-center"
          label={t(methods.email_verified ? "auth.verifyEmail.statusVerified" : "auth.verifyEmail.statusUnverified")}
          description={methods.email_verified ? undefined : t("auth.verifyEmail.unverifiedWhy")}
          control={!methods.email_verified && <Button size="sm" variant="outline" disabled={refreshing || error || verifying} onClick={sendVerificationLink}>{t(verifying ? "auth.verifyEmail.sending" : "auth.verifyEmail.sendLink")}</Button>}
        />
        {notice && <SettingsBlock><p role="status" className={notice.failed ? "text-sm text-destructive" : "text-sm text-muted-foreground"}>{notice.text}</p></SettingsBlock>}
          {changingEmail && (
            <SettingsBlock>
              <EmailChangeForm
                jwt={jwt}
                passwordAvailable={methods.password}
                googleLinked={methods.google}
                statusUnavailable={refreshing || error}
                onSetPassword={() => {
                  setChangingEmail(false)
                  setRecovering(true)
                }}
                onBack={() => setChangingEmail(false)}
              />
            </SettingsBlock>
          )}
          <SettingsRow
            className="flex-wrap items-center"
            label={t(
              methods.password
                ? "auth.methods.passwordSet"
                : "auth.methods.passwordMissing",
            )}
            control={
              !(changingEmail && !methods.password) && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={refreshing || error}
                  onClick={() => {
                    setChangingEmail(false)
                    setRecovering(true)
                  }}
                >
                  {t(
                    methods.password
                      ? "auth.methods.resetPassword"
                      : "auth.methods.setPassword",
                  )}
                </Button>
              )
            }
          />
          {recovering && (
            <SettingsBlock>
              <div className="max-w-md">
                <PasswordManagement
                  jwt={jwt}
                  username={username}
                  google={methods.google}
                  googleAvailable={methods.google_available}
                  passwordSet={methods.password}
                  onChanged={() => {
                    setRecovering(false)
                    setRevision((n) => n + 1)
                  }}
                />
                <Button variant="ghost" onClick={() => setRecovering(false)}>
                  {t("auth.methods.back")}
                </Button>
              </div>
            </SettingsBlock>
          )}
          <SettingsRow
            className="flex-wrap items-center"
            label={
              <span className="inline-flex items-center gap-2">
                <img src={googleLogo} alt="" className="size-4" />
                {t(
                  methods.google
                    ? "auth.methods.connected"
                    : "auth.methods.notConnected",
                )}
              </span>
            }
            description={
              <span className="block space-y-1">
                {!methods.google_available && (
                  <span className="block">
                    {t(
                      resolveBackendEnvironment().kind === "preview"
                        ? "auth.methods.previewDisabled"
                        : "auth.methods.unavailable",
                    )}
                  </span>
                )}
                {methods.google && !methods.password && (
                  <span className="block">{t("auth.methods.lastMethod")}</span>
                )}
                {methods.google_available && (
                  <span className="block text-xs">
                    {t("auth.google.privacy")}
                  </span>
                )}
              </span>
            }
            control={
              <>
                {methods.google && methods.password && !disconnecting && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setDisconnecting(true)}
                  >
                    {t("auth.methods.disconnect")}
                  </Button>
                )}
                {!methods.google && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || !methods.google_available}
                    onClick={() => {
                      setBusy(true)
                      setError(false)
                      void startGoogleLogin(
                        "/preferences/login-methods",
                        false,
                        username,
                      ).catch(() => {
                        setError(true)
                        setBusy(false)
                      })
                    }}
                  >
                    {t("auth.methods.connect")}
                  </Button>
                )}
              </>
            }
          />
          {disconnecting && (
            <SettingsBlock>
              <form
                className="flex max-w-md flex-col gap-4"
                onSubmit={(event) => {
                  event.preventDefault()
                  if (busy) return
                  setBusy(true)
                  setError(false)
                  void googleRequest("disconnect", { password }, jwt)
                    .then(() => {
                      setDisconnecting(false)
                      setRevision((n) => n + 1)
                    })
                    .catch(() => setError(true))
                    .finally(() => {
                      setPassword("")
                      setBusy(false)
                    })
                }}
              >
                <p className="text-sm text-muted-foreground">
                  {t("auth.methods.disconnectNote")}
                </p>
                <FieldGroup>
                  <Field>
                    <FieldLabel htmlFor="disconnect-google-password">
                      {t("auth.google.passwordLabel")}
                    </FieldLabel>
                    <RevealableInput
                      id="disconnect-google-password"
                      autoComplete="current-password"
                      required
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                    />
                  </Field>
                </FieldGroup>
                <div className="flex flex-wrap gap-2">
                  <Button type="submit" disabled={busy}>
                    {t("auth.methods.disconnect")}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => {
                      setDisconnecting(false)
                      setPassword("")
                    }}
                  >
                    {t("common.cancel")}
                  </Button>
                </div>
              </form>
            </SettingsBlock>
          )}
          {!error && (
            <SettingsBlock className="flex items-center justify-end py-2">
              <Button
                size="sm"
                variant="ghost"
                disabled={refreshing}
                onClick={() => setRevision((n) => n + 1)}
              >
                <RefreshCw
                  className={refreshing ? "size-3.5 animate-spin" : "size-3.5"}
                  aria-hidden="true"
                />
                {t("auth.methods.refresh")}
              </Button>
            </SettingsBlock>
          )}
        </>
      )}
    </SettingsGroup>
  )
}
