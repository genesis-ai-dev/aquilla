// AQU-626: per-user deep link + PIN landing page (fresh-browser / diode-zone
// flow).
//
// A translator in a surveillance-sensitive context reaches Aquilla via a link
// placed inside a diode zone, opened in a Brave profile that wipes on close —
// so every visit is a fresh browser with no stored session. This page is the
// destination of `/link/:token`: it collects the per-user PIN, redeems it for a
// session on the bound account, and lands them straight in their project,
// skipping onboarding.
//
// The link alone grants nothing — the PIN is required. Every failure (unknown /
// expired / revoked / locked link, or wrong PIN) shows one indistinguishable
// message, matching the server: a wrong PIN behaves like a dead link.

import { useState, type FormEvent } from "react"
import { useNavigate, useParams } from "react-router-dom"
import { redeemAccessLink } from "@/lib/frontier/auth"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useT } from "@/lib/i18n/I18nProvider"

export function AccessLinkPage() {
  const t = useT()
  const { token } = useParams<{ token: string }>()
  const navigate = useNavigate()
  const [pin, setPin] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (!token || submitting) return
    setSubmitting(true)
    setError(null)
    try {
      const { projectId } = await redeemAccessLink(token, pin.trim())
      // Mark onboarding complete so the fresh browser is never bounced to the
      // onboarding wizard / marketing homepage — this account is already
      // provisioned; the link IS the onboarding. saveSession (inside redeem)
      // already set the aq_hint cookie.
      try {
        localStorage.setItem("codex:onboardingComplete", "true")
      } catch {
        // Private-mode / storage-blocked: navigation below still works; the
        // RootRedirect guard only matters at "/", not the project route.
      }
      navigate(`/project/${projectId}/editor`, { replace: true })
    } catch (err) {
      // AQU-820: redeemAccessLink() (lib/frontier/auth.ts) always throws with
      // an already-translated, keyed message now — either the generic
      // dead-link text or the network-unreachable text — never raw server
      // English, so it's safe to display directly. The `!/^Login failed/`
      // check this replaced was dead: redeemAccessLink never produces that
      // string, so err.message unconditionally won regardless, which was
      // exactly the keyed-but-dead bug (auth.accessLink.genericError could
      // never render). Only a genuinely unexpected non-Error throw falls
      // back to the generic key here.
      const message = err instanceof Error ? err.message : t("auth.accessLink.genericError")
      setError(message)
      setPin("")
      setSubmitting(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-sm space-y-5 rounded-lg border bg-card p-6 shadow-sm"
        aria-label={t("auth.accessLink.ariaLabel")}
      >
        <div className="space-y-1 text-center">
          <h1 className="text-lg font-semibold">{t("auth.accessLink.title")}</h1>
          <p className="text-sm text-muted-foreground">
            {t("auth.accessLink.instructions")}
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="access-pin">{t("auth.accessLink.pinLabel")}</Label>
          <Input
            id="access-pin"
            type="password"
            inputMode="numeric"
            autoComplete="one-time-code"
            autoFocus
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            disabled={submitting}
            data-testid="access-pin-input"
          />
        </div>

        {error && (
          <p className="text-sm text-red-600" role="alert" data-testid="access-link-error">
            {error}
          </p>
        )}

        <Button type="submit" className="w-full" disabled={submitting || pin.trim().length === 0}>
          {submitting ? t("auth.accessLink.submitOpening") : t("auth.accessLink.submitDefault")}
        </Button>
      </form>
    </div>
  )
}
