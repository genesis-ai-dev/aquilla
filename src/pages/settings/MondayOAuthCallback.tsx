// /oauth/callback — Monday.com OAuth landing page.
//
// Monday's registered redirect URI points at this SPA route (not the worker).
// On mount we forward `code` + `state` to the auth-worker's exchange endpoint
// exactly once (the code is single-use — a ref guards React strict-mode's
// double effect), then bounce to `backTo` with `?monday=connected`.
// OrgSettingsMonday renders that param as an inline notice — this app has no
// global toast system.
//
// A failure (cancelled in Monday, approved too late, refused) stays on this
// page with a plain message, and "Back to Aquilla" returns to `backTo` with
// `?monday=error&reason=…` so the settings page shows it too. Either way the
// tab that opened this one is told (lib/monday/oauth-return.ts), so it stops
// waiting.

import { useEffect, useRef, useState } from "react"
import { Link, useNavigate, useSearchParams } from "react-router-dom"
import { Spinner } from "@/components/ui/spinner"
import { useI18n } from "@/lib/i18n/I18nProvider"
import { completeMondayOAuth } from "@/lib/monday/api"
import {
  announceMondayOAuthOutcome,
  connectFailureKey,
  peekMondayOAuthState,
  toConnectFailure,
  type MondayConnectFailure,
} from "@/lib/monday/oauth-return"

// Last resort only — the state names the org whenever Monday sends it back.
// (It used to be "/settings/monday", which has no route at all.)
const FALLBACK = "/orgs/all"

function withParam(path: string, params: Record<string, string>): string {
  const qs = new URLSearchParams(params).toString()
  return `${path}${path.includes("?") ? "&" : "?"}${qs}`
}

export function MondayOAuthCallback() {
  const { t } = useI18n()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const [exchangeError, setExchangeError] = useState<MondayConnectFailure | null>(null)
  const ranRef = useRef(false)

  const code = searchParams.get("code")
  const state = searchParams.get("state")
  // Monday's cancel/deny redirect carries `error` (e.g. access_denied) and no code.
  const mondayError = searchParams.get("error")
  const { backTo: stateBackTo, orgId } = peekMondayOAuthState(state)
  const returnTo = stateBackTo ?? (orgId != null ? `/orgs/${orgId}/settings/monday` : FALLBACK)
  // Derived, not stateful: whether Monday sent us the params is knowable at
  // render time, so it never needs an effect.
  const failed: MondayConnectFailure | null =
    !code || !state ? toConnectFailure(mondayError) : exchangeError

  useEffect(() => {
    if (ranRef.current) return
    if (!code || !state) {
      ranRef.current = true
      announceMondayOAuthOutcome({ ok: false, reason: toConnectFailure(mondayError), orgId })
      return
    }
    ranRef.current = true

    void completeMondayOAuth(code, state).then((result) => {
      if (result.ok) {
        announceMondayOAuthOutcome({ ok: true, orgId })
        // Server validates backTo is an app path; keep a client-side guard so
        // a malformed value can never leave the SPA.
        const backTo = result.backTo.startsWith("/") && !result.backTo.startsWith("//") ? result.backTo : returnTo
        navigate(withParam(backTo, { monday: "connected" }), { replace: true })
      } else {
        const reason = toConnectFailure(result.reason)
        announceMondayOAuthOutcome({ ok: false, reason, orgId })
        setExchangeError(reason)
      }
    })
  }, [navigate, code, state, mondayError, orgId, returnTo])

  if (failed) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3 px-6 text-center">
        <p className="text-sm font-medium">{t("settings.monday.callback.failedTitle")}</p>
        <p className="max-w-md text-sm text-muted-foreground">{t(connectFailureKey(failed))}</p>
        <Link
          to={withParam(returnTo, { monday: "error", reason: failed })}
          className="text-sm font-medium underline underline-offset-4"
        >
          {t("settings.monday.callback.backToApp")}
        </Link>
      </div>
    )
  }

  return (
    <div className="flex h-screen items-center justify-center">
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner /> {t("settings.monday.callback.connecting")}
      </p>
    </div>
  )
}
