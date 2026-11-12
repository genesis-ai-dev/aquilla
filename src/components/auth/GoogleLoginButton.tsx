import { useEffect, useState } from "react"
import googleLogo from "@/assets/google-login/g-logo.png"
import "./google-login-button.css"
import { Button } from "@/components/ui/button"
import { useT } from "@/lib/i18n/I18nProvider"
import { googleRequest, startGoogleLogin } from "@/lib/frontier/google-login"
import { safeLoginNext } from "@/lib/navigation/login-path"

export function GoogleLoginButton({ next, signup = false }: { next?: string; signup?: boolean }) {
  const t = useT()
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState(false)
  const [configFailed, setConfigFailed] = useState(false)
  const [check, setCheck] = useState(0)
  useEffect(() => {
    let mounted = true
    setConfigFailed(false)
    // First-party capability check only; no Google request or asset preload.
    void googleRequest<{ enabled: boolean }>("config").then(c => {
      if (typeof c?.enabled !== "boolean") throw new Error("unavailable")
      if (mounted) setEnabled(c.enabled)
    }).catch(() => { if (mounted) setConfigFailed(true) })
    return () => { mounted = false }
  }, [check])
  useEffect(() => {
    const retry = () => setCheck(value => value + 1)
    window.addEventListener("online", retry)
    return () => window.removeEventListener("online", retry)
  }, [])
  if (configFailed || enabled === false) return <div className="flex flex-col gap-2">
    <Button className="google-login-button" type="button" variant="outline" disabled>
      <img src={googleLogo} width={20} height={20} alt="" aria-hidden="true" />
      {t("auth.google.continue")}
    </Button>
    <p role="alert" className="text-sm text-muted-foreground">{t("auth.google.unavailable")}</p>
    <Button type="button" variant="outline" onClick={() => setCheck(value => value + 1)}>{t("auth.google.retryAvailability")}</Button>
  </div>
  if (!enabled) return null
  const current = window.location.pathname + window.location.search
  const destination = next ?? new URLSearchParams(window.location.search).get("next") ?? current
  return <div className="flex flex-col gap-4">
    <Button className="google-login-button" type="button" variant="outline" disabled={pending} onClick={() => {
      setPending(true); setError(false)
      void startGoogleLogin(safeLoginNext(destination), signup).catch(() => { setError(true); setPending(false) })
    }}>
      <img src={googleLogo} width={20} height={20} alt="" aria-hidden="true" />
      {t(pending ? "auth.google.redirecting" : "auth.google.continue")}
    </Button>
    {error && <p role="alert" className="text-sm text-destructive">{t("auth.google.startFailed")}</p>}
    <div className="flex items-center gap-4 text-xs text-muted-foreground">
      <span aria-hidden="true" className="h-px flex-1 bg-border" />
      <span>{t("auth.google.or")}</span>
      <span aria-hidden="true" className="h-px flex-1 bg-border" />
    </div>
  </div>
}
