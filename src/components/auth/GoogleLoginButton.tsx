import { useEffect, useState } from "react"
import googleLogo from "@/assets/google-login/g-logo.png"
import "./google-login-button.css"
import { Button } from "@/components/ui/button"
import { useT } from "@/lib/i18n/I18nProvider"
import { googleRequest, startGoogleLogin } from "@/lib/frontier/google-login"
import { safeLoginNext } from "@/lib/navigation/login-path"

export function GoogleLoginButton({ next, signup = false }: { next?: string; signup?: boolean }) {
  const t = useT()
  const [enabled, setEnabled] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState(false)
  useEffect(() => {
    let mounted = true
    // First-party capability check only; no Google request or asset preload.
    void googleRequest<{ enabled: boolean }>("config").then(c => { if (mounted) setEnabled(c.enabled) }).catch(() => {})
    return () => { mounted = false }
  }, [])
  if (!enabled) return null
  const current = window.location.pathname + window.location.search
  const destination = next ?? new URLSearchParams(window.location.search).get("next") ?? current
  return <div className="flex flex-col gap-2">
    <Button className="google-login-button" type="button" variant="outline" disabled={pending} onClick={() => {
      setPending(true); setError(false)
      void startGoogleLogin(safeLoginNext(destination), signup).catch(() => { setError(true); setPending(false) })
    }}>
      <img src={googleLogo} width={20} height={20} alt="" aria-hidden="true" />
      {t(pending ? "auth.google.redirecting" : "auth.google.continue")}
    </Button>
    <p className="text-xs text-muted-foreground">{t("auth.google.privacy")}</p>
    {error && <p role="alert" className="text-sm text-destructive">{t("auth.google.startFailed")}</p>}
  </div>
}
