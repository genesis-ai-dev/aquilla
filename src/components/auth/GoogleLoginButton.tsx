import { useEffect, useState } from "react"
import googleLogo from "@/assets/google-login/g-logo.png"
import "./google-login-button.css"
import { Button } from "@/components/ui/button"
import { useT } from "@/lib/i18n/I18nProvider"
import { googleRequest, startGoogleLogin } from "@/lib/frontier/google-login"
import { resolveBackendEnvironment } from "@/lib/deployment-environment"
import { isTauriRuntime } from "@/lib/offline/is-tauri"
import { safeLoginNext } from "@/lib/navigation/login-path"

export function GoogleLoginButton({ next, signup = false }: { next?: string; signup?: boolean }) {
  const t = useT()
  const desktop = isTauriRuntime() || ["app:", "tauri:"].includes(window.location.protocol)
  const preview = resolveBackendEnvironment().kind === "preview"
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [configFailed, setConfigFailed] = useState(false)
  const [check, setCheck] = useState(0)
  useEffect(() => {
    if (preview || desktop) return
    let mounted = true
    setConfigFailed(false)
    // First-party capability check only; no Google request or asset preload.
    void googleRequest<{ enabled: boolean }>("config").then(c => {
      if (typeof c?.enabled !== "boolean") throw new Error("unavailable")
      if (mounted) setEnabled(c.enabled)
    }).catch(() => { if (mounted) setConfigFailed(true) })
    return () => { mounted = false }
  }, [check, preview, desktop])
  useEffect(() => {
    const retry = () => setCheck(value => value + 1)
    window.addEventListener("online", retry)
    return () => window.removeEventListener("online", retry)
  }, [])
  if (preview || desktop || configFailed || enabled !== true) return <div className="flex flex-col gap-2">
    <Button className="google-login-button" type="button" variant="outline" disabled>
      <img src={googleLogo} width={20} height={20} alt="" aria-hidden="true" />
      {t("auth.google.continue")}
    </Button>
    <p role={preview || enabled === null && !configFailed ? "status" : "alert"} className="text-sm text-muted-foreground">{t(preview ? "auth.google.previewDisabled" : desktop ? "auth.google.desktopUnsupported" : configFailed ? "auth.google.unavailable" : enabled === null ? "auth.google.checkingAvailability" : "auth.google.notConfigured")}</p>
    {!preview && !desktop && configFailed && <Button className="self-start" type="button" variant="link" size="sm" onClick={() => setCheck(value => value + 1)}>{t("auth.google.retryAvailability")}</Button>}
  </div>
  const current = window.location.pathname + window.location.search
  const destination = next ?? new URLSearchParams(window.location.search).get("next") ?? current
  return <div className="flex flex-col gap-4">
    <Button className="google-login-button" type="button" variant="outline" disabled={pending} onClick={() => {
      setPending(true); setError(null)
      void startGoogleLogin(safeLoginNext(destination), signup).catch((failure: unknown) => { setError(failure instanceof Error ? failure.message : "unknown"); setPending(false) })
    }}>
      <img src={googleLogo} width={20} height={20} alt="" aria-hidden="true" />
      {t(pending ? "auth.google.redirecting" : "auth.google.continue")}
    </Button>
    {error && <p role="alert" className="text-sm text-destructive">{t(error === "invalid_origin" ? "auth.google.startOrigin" : error === "desktop_unsupported" ? "auth.google.desktopUnsupported" : error === "offline" ? "auth.google.startOffline" : error === "storage_unavailable" ? "auth.google.startStorage" : error === "timeout" ? "auth.google.startTimeout" : error === "network_error" ? "auth.google.startNetwork" : error === "rate_limited" ? "auth.google.startRateLimited" : error === "service_unavailable" || error === "unavailable" ? "auth.google.startService" : "auth.google.startFailed")}</p>}
    <div className="flex items-center gap-4 text-xs text-muted-foreground">
      <span aria-hidden="true" className="h-px flex-1 bg-border" />
      <span>{t("auth.google.or")}</span>
      <span aria-hidden="true" className="h-px flex-1 bg-border" />
    </div>
  </div>
}
