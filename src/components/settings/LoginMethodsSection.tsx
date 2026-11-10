import { Spinner } from "@/components/ui/spinner"
import { useEffect, useState } from "react"
import { useAccounts } from "@/hooks/useAccounts"
import { useT } from "@/lib/i18n/I18nProvider"
import { Button } from "@/components/ui/button"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { RevealableInput } from "@/components/ui/revealable-input"
import { SettingsGroup } from "@/components/ui/page"
import { FrontierForgotPasswordForm } from "@/components/git-import/FrontierForgotPasswordForm"
import { googleRequest, startGoogleLogin } from "@/lib/frontier/google-login"

export function LoginMethodsSection() {
  const { active } = useAccounts()
  return active ? <AccountLoginMethods key={active.username} jwt={active.jwt} username={active.username} /> : null
}
function AccountLoginMethods({ jwt, username }: { jwt: string; username: string }) {
  const t = useT()
  const [methods, setMethods] = useState<{ password: boolean; google: boolean; google_available: boolean } | null>(null)
  const [error, setError] = useState(false), [busy, setBusy] = useState(false)
  const [disconnecting, setDisconnecting] = useState(false), [password, setPassword] = useState("")
  const [recovering, setRecovering] = useState(false), [revision, setRevision] = useState(0)
  useEffect(() => {
    let current = true
    setMethods(null); setError(false)
    void googleRequest<NonNullable<typeof methods>>("methods", undefined, jwt)
      .then(value => { if (current) setMethods(value) })
      .catch(() => { if (current) setError(true) })
    return () => { current = false }
  }, [jwt, revision])
  return <SettingsGroup label={t("auth.methods.title")}>
    <div className="flex flex-col gap-4">
      <p>{t("auth.methods.description")}</p>
      {error && <p role="alert">{t("auth.methods.failed")}</p>}
      {!methods && !error && <Spinner />}
      {!methods && error && <Button variant="outline" onClick={() => setRevision(n => n + 1)}>{t("auth.methods.refresh")}</Button>}
      {methods && <>
        <p>{t(methods.password ? "auth.methods.passwordSet" : "auth.methods.passwordMissing")}</p>
        <p>{t(methods.google ? "auth.methods.connected" : "auth.methods.notConnected")}</p>
        {methods.google && !methods.password && <p>{t("auth.methods.lastMethod")}</p>}
        {methods.google && methods.password && !disconnecting && <Button variant="outline" onClick={() => setDisconnecting(true)}>{t("auth.methods.disconnect")}</Button>}
        {disconnecting && <form className="flex flex-col gap-3" onSubmit={event => {
          event.preventDefault(); if (busy) return
          setBusy(true); setError(false)
          void googleRequest("disconnect", { password }, jwt).then(() => {
            setDisconnecting(false); setRevision(n => n + 1)
          }).catch(() => setError(true)).finally(() => { setPassword(""); setBusy(false) })
        }}>
          <p>{t("auth.methods.disconnectNote")}</p>
          <FieldGroup><Field><FieldLabel htmlFor="disconnect-google-password">{t("auth.google.passwordLabel")}</FieldLabel>
            <RevealableInput id="disconnect-google-password" autoComplete="current-password" required value={password} onChange={e => setPassword(e.target.value)} /></Field></FieldGroup>
          <Button type="submit" disabled={busy}>{t("auth.methods.disconnect")}</Button>
          <Button type="button" variant="ghost" disabled={busy} onClick={() => { setDisconnecting(false); setPassword("") }}>{t("common.cancel")}</Button>
        </form>}
        {!methods.google && methods.google_available && <Button variant="outline" disabled={busy} onClick={() => {
          setBusy(true); setError(false)
          void startGoogleLogin("/preferences/login-methods", false, username).catch(() => { setError(true); setBusy(false) })
        }}>{t("auth.methods.connect")}</Button>}
        {!methods.google && !methods.google_available && <p>{t("auth.methods.unavailable")}</p>}
        <p className="text-sm text-muted-foreground">{t("auth.google.privacy")}</p>
        {!methods.password && <Button variant="outline" onClick={() => setRecovering(true)}>{t("auth.methods.setPassword")}</Button>}
        {recovering && <FrontierForgotPasswordForm onBack={() => setRecovering(false)} returnTo="/preferences/login-methods" />}
        <Button variant="ghost" onClick={() => setRevision(n => n + 1)}>{t("auth.methods.refresh")}</Button>
      </>}
    </div>
  </SettingsGroup>
}
