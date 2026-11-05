import { useEffect, useState } from "react"
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
    <Button type="button" variant="outline" disabled={pending} onClick={() => {
      setPending(true); setError(false)
      void startGoogleLogin(safeLoginNext(destination), signup).catch(() => { setError(true); setPending(false) })
    }}>
      <svg data-icon="inline-start" viewBox="0 0 48 48" aria-hidden="true">
        <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5Z" />
        <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65Z" />
        <path fill="#FBBC05" d="M10.53 28.59A14.41 14.41 0 0 1 9.75 24c0-1.59.27-3.13.76-4.59l-7.98-6.19A23.87 23.87 0 0 0 0 24c0 3.87.93 7.53 2.56 10.78l7.97-6.19Z" />
        <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.91-5.8l-7.73-6c-2.15 1.45-4.92 2.3-8.18 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48Z" />
      </svg>
      {t(pending ? "auth.google.redirecting" : "auth.google.continue")}
    </Button>
    <p className="text-xs text-muted-foreground">{t("auth.google.privacy")}</p>
    {error && <p role="alert" className="text-sm text-destructive">{t("auth.google.startFailed")}</p>}
  </div>
}
