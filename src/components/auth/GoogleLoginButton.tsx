import { useEffect, useRef, useState } from "react"
import googleLogo from "@/assets/google-login/g-logo.png"
import "./google-login-button.css"
import { Button } from "@/components/ui/button"
import { useT } from "@/lib/i18n/I18nProvider"
import { GOOGLE_ATTEMPT_LIFETIME_MS, googleRequest, startGoogleLogin } from "@/lib/frontier/google-login"
import { resolveBackendEnvironment } from "@/lib/deployment-environment"
import { isTauriRuntime } from "@/lib/offline/is-tauri"
import { safeLoginNext } from "@/lib/navigation/login-path"

export function GoogleLoginButton({ next, signup = false }: { next?: string; signup?: boolean }) {
  const t = useT()
  const desktop = isTauriRuntime() || ["app:", "tauri:"].includes(window.location.protocol)
  const preview = resolveBackendEnvironment().kind === "preview"
  const [desktopEnabled, setDesktopEnabled] = useState(false)
  const [canUsePrivateSession, setCanUsePrivateSession] = useState(false)
  const [privateSession, setPrivateSession] = useState(false)
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const loginRequest = useRef<AbortController | null>(null)
  const [pending, setPending] = useState(false)
  const [ended, setEnded] = useState<"cancelled" | "expired" | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [configFailed, setConfigFailed] = useState(false)
  const [check, setCheck] = useState(0)
  useEffect(() => {
    if (preview) return
    let mounted = true
    setConfigFailed(false)
    // First-party capability check only; no Google request or asset preload.
    void googleRequest<{ enabled: boolean; desktop?: boolean }>("config").then(async c => {
      const nativeReady = !desktop || await import("@tauri-apps/api/core").then(({ invoke }) => invoke<boolean>("google_login_supported")).catch(() => false)
      if (desktop && nativeReady && c?.desktop) {
        const { invoke } = await import("@tauri-apps/api/core")
        const supported = await invoke<boolean>("google_private_session_supported").catch(() => false)
        if (mounted) setCanUsePrivateSession(supported === true)
      }
      if (typeof c?.enabled !== "boolean") throw new Error("unavailable")
      if (mounted) { setEnabled(c.enabled); setDesktopEnabled(c.desktop === true && nativeReady) }
    }).catch(() => { if (mounted) setConfigFailed(true) })
    return () => { mounted = false }
  }, [check, preview, desktop])
  useEffect(() => {
    const retry = () => setCheck(value => value + 1)
    window.addEventListener("online", retry)
    return () => window.removeEventListener("online", retry)
  }, [])
  useEffect(() => () => { loginRequest.current?.abort() }, [])
  useEffect(() => {
    if (!desktop || !pending || ended) return
    const timeout = window.setTimeout(() => {
      loginRequest.current?.abort()
      setEnded("expired")
    }, GOOGLE_ATTEMPT_LIFETIME_MS)
    return () => window.clearTimeout(timeout)
  }, [desktop, pending, ended])
  if (desktop && pending) return <div data-google-login-pending className="flex flex-col gap-3">
    <div role="status">
      <p className="font-medium">{t("auth.google.desktopWaitingTitle")}</p>
      <p className="mt-1 text-sm text-muted-foreground">{t(ended === "cancelled" ? "auth.google.desktopClosed" : ended === "expired" ? "auth.google.desktopExpired" : "auth.google.desktopWaitingHint")}</p>
    </div>
    <Button type="button" variant="outline" autoFocus onClick={() => {
      loginRequest.current?.abort()
      setPending(false)
    }}>{t("auth.google.cancelAndSwitch")}</Button>
  </div>
  if (preview || (desktop && enabled === true && !desktopEnabled) || configFailed || enabled !== true) return <div className="flex flex-col gap-2">
    <Button className="google-login-button" type="button" variant="outline" disabled>
      <img src={googleLogo} width={20} height={20} alt="" aria-hidden="true" />
      {t("auth.google.continue")}
    </Button>
    <p role={preview || enabled === null && !configFailed ? "status" : "alert"} className="text-sm text-muted-foreground">{t(preview ? "auth.google.previewDisabled" : desktop && enabled === true && !desktopEnabled ? "auth.google.desktopUnsupported" : configFailed ? "auth.google.unavailable" : enabled === null ? "auth.google.checkingAvailability" : "auth.google.notConfigured")}</p>
    {!preview && configFailed && <Button className="self-start" type="button" variant="link" size="sm" onClick={() => setCheck(value => value + 1)}>{t("auth.google.retryAvailability")}</Button>}
  </div>
  const current = window.location.pathname + window.location.search
  const destination = next ?? new URLSearchParams(window.location.search).get("next") ?? current
  return <div className="flex flex-col gap-4">
    <Button className="google-login-button" type="button" variant="outline" disabled={pending} onClick={() => {
      const request = new AbortController()
      loginRequest.current = request
      setEnded(null); setPending(true); setError(null)
      void startGoogleLogin(safeLoginNext(destination), signup, undefined, false, request.signal, canUsePrivateSession && privateSession).catch((failure: unknown) => {
        if (request.signal.aborted) return
        if (desktop && failure instanceof Error && failure.message === "cancelled") {
          setEnded("cancelled")
          return
        }
        setError(failure instanceof Error ? failure.message : "unknown")
        setPending(false)
      })
    }}>
      <img src={googleLogo} width={20} height={20} alt="" aria-hidden="true" />
      {t(pending ? "auth.google.redirecting" : "auth.google.continue")}
    </Button>
    {canUsePrivateSession && <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" checked={privateSession} onChange={event => setPrivateSession(event.target.checked)} />
      {t("auth.google.privateSession")}
    </label>}
    {error && <p role="alert" className="text-sm text-destructive">{t(error === "browser_open_failed" ? "auth.google.browserOpenFailed" : error === "invalid_origin" ? "auth.google.startOrigin" : error === "desktop_unsupported" ? "auth.google.desktopUnsupported" : error === "offline" ? "auth.google.startOffline" : error === "storage_unavailable" ? "auth.google.startStorage" : error === "timeout" ? "auth.google.startTimeout" : error === "network_error" ? "auth.google.startNetwork" : error === "rate_limited" ? "auth.google.startRateLimited" : error === "service_unavailable" || error === "unavailable" ? "auth.google.startService" : "auth.google.startFailed")}</p>}
    <div className="flex items-center gap-4 text-xs text-muted-foreground">
      <span aria-hidden="true" className="h-px flex-1 bg-border" />
      <span>{t("auth.google.or")}</span>
      <span aria-hidden="true" className="h-px flex-1 bg-border" />
    </div>
  </div>
}
