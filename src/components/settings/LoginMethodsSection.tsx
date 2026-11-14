import { EmailChangeForm } from "./EmailChangeForm"
import { Spinner } from "@/components/ui/spinner"
import { notifySessionExpiredIfCurrent } from "@/lib/frontier/session-expiry"
import { useEffect, useState } from "react"
import { useAccounts } from "@/hooks/useAccounts"
import { useT } from "@/lib/i18n/I18nProvider"
import { Button } from "@/components/ui/button"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { RevealableInput } from "@/components/ui/revealable-input"
import { SettingsGroup, SettingsRow, SettingsBlock } from "@/components/ui/page"
import { FrontierForgotPasswordForm } from "@/components/git-import/FrontierForgotPasswordForm"
import { googleRequest, startGoogleLogin } from "@/lib/frontier/google-login"

export function LoginMethodsSection() {
  const { active } = useAccounts()
  return active ? <AccountLoginMethods key={active.username} jwt={active.jwt} username={active.username} /> : null
}
function AccountLoginMethods({ jwt, username }: { jwt: string; username: string }) {
  const t = useT()
  const [changingEmail, setChangingEmail] = useState(false)
  const [methods, setMethods] = useState<{ email: string; password: boolean; google: boolean; google_available: boolean } | null>(null)
  const [error, setError] = useState(false), [busy, setBusy] = useState(false)
  const [sessionExpired, setSessionExpired] = useState(false)
  const [refreshing, setRefreshing] = useState(true)
  const [disconnecting, setDisconnecting] = useState(false), [password, setPassword] = useState("")
  const [recovering, setRecovering] = useState(false), [revision, setRevision] = useState(0)
  useEffect(() => {
    let current = true
    setRefreshing(true); setError(false); setSessionExpired(false)
    void googleRequest<NonNullable<typeof methods>>("methods", undefined, jwt)
      .then(value => { if (current) setMethods(value) })
      .catch(reason => {
        if (!current) return
        const rejected = reason instanceof Error && reason.message === "session_expired"
        setError(true)
        setSessionExpired(rejected)
        if (rejected) void notifySessionExpiredIfCurrent(jwt)
      })
      .finally(() => { if (current) setRefreshing(false) })
    return () => { current = false }
  }, [jwt, revision])
  useEffect(() => {
    const refreshOnReturn = () => {
      if (document.visibilityState === "visible") setRevision(n => n + 1)
    }
    window.addEventListener("focus", refreshOnReturn)
    document.addEventListener("visibilitychange", refreshOnReturn)
    return () => {
      window.removeEventListener("focus", refreshOnReturn)
      document.removeEventListener("visibilitychange", refreshOnReturn)
    }
  }, [])
  if (sessionExpired) return null // The shared recovery banner owns this state.
  return <SettingsGroup>
      {error && <SettingsBlock><p role="alert" className="text-sm text-destructive">{t("auth.methods.failed")}</p><Button size="sm" variant="outline" onClick={() => setRevision(n => n + 1)}>{t("auth.methods.refresh")}</Button></SettingsBlock>}
      {!methods && !error && <SettingsBlock><Spinner /></SettingsBlock>}
      {methods && <>
        <SettingsRow label={methods.email} description={t("auth.emailChange.accountEmail")} control={<Button size="sm" variant="outline" disabled={refreshing || error} onClick={() => { setRecovering(false); setChangingEmail(true) }}>{t("auth.emailChange.action")}</Button>} />
        {changingEmail && <SettingsBlock><EmailChangeForm jwt={jwt} passwordAvailable={methods.password} googleLinked={methods.google} statusUnavailable={refreshing || error} onSetPassword={() => { setChangingEmail(false); setRecovering(true) }} onBack={() => setChangingEmail(false)} /></SettingsBlock>}
        <SettingsRow
          className="flex-wrap items-center"
          label={t(methods.password ? "auth.methods.passwordSet" : "auth.methods.passwordMissing")}
          control={!(changingEmail && !methods.password) && <Button size="sm" variant="outline" disabled={refreshing || error} onClick={() => { setChangingEmail(false); setRecovering(true) }}>{t(methods.password ? "auth.methods.resetPassword" : "auth.methods.setPassword")}</Button>}
        />
        {recovering && <SettingsBlock><div className="max-w-md"><FrontierForgotPasswordForm account={{ email: methods.email, jwt }} backLabel={t("auth.methods.back")} onBack={() => setRecovering(false)} returnTo="/preferences/login-methods" /></div></SettingsBlock>}
        <SettingsRow
          className="flex-wrap items-center"
          label={t(methods.google ? "auth.methods.connected" : "auth.methods.notConnected")}
          description={methods.google && !methods.password ? t("auth.methods.lastMethod") : !methods.google && !methods.google_available ? t("auth.methods.unavailable") : undefined}
          control={<>
            {methods.google && methods.password && !disconnecting && <Button size="sm" variant="outline" onClick={() => setDisconnecting(true)}>{t("auth.methods.disconnect")}</Button>}
            {!methods.google && methods.google_available && <Button size="sm" variant="outline" disabled={busy} onClick={() => {
              setBusy(true); setError(false)
              void startGoogleLogin("/preferences/login-methods", false, username).catch(() => { setError(true); setBusy(false) })
            }}>{t("auth.methods.connect")}</Button>}
          </>}
        />
        {disconnecting && <SettingsBlock><form className="flex max-w-md flex-col gap-4" onSubmit={event => {
          event.preventDefault(); if (busy) return
          setBusy(true); setError(false)
          void googleRequest("disconnect", { password }, jwt).then(() => {
            setDisconnecting(false); setRevision(n => n + 1)
          }).catch(() => setError(true)).finally(() => { setPassword(""); setBusy(false) })
        }}>
          <p className="text-sm text-muted-foreground">{t("auth.methods.disconnectNote")}</p>
          <FieldGroup><Field><FieldLabel htmlFor="disconnect-google-password">{t("auth.google.passwordLabel")}</FieldLabel>
            <RevealableInput id="disconnect-google-password" autoComplete="current-password" required value={password} onChange={e => setPassword(e.target.value)} /></Field></FieldGroup>
          <div className="flex flex-wrap gap-2"><Button type="submit" disabled={busy}>{t("auth.methods.disconnect")}</Button>
          <Button type="button" variant="ghost" disabled={busy} onClick={() => { setDisconnecting(false); setPassword("") }}>{t("common.cancel")}</Button>
          </div>
        </form></SettingsBlock>}
        <SettingsBlock className="flex flex-col items-start gap-3">
          <p className="text-xs text-muted-foreground">{t("auth.google.privacy")}</p>
          {!error && <Button size="sm" variant="ghost" onClick={() => setRevision(n => n + 1)}>{t("auth.methods.refresh")}</Button>}
        </SettingsBlock>
      </>}
  </SettingsGroup>
}
