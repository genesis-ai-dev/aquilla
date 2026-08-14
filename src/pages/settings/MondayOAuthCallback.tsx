// /oauth/callback — Monday.com OAuth landing page.
//
// Monday's registered redirect URI points at this SPA route (not the worker).
// On mount we forward `code` + `state` to the auth-worker's exchange endpoint
// exactly once (the code is single-use — a ref guards React strict-mode's
// double effect), then bounce to `backTo` with a `?monday=connected|error`
// param. OrgSettingsMonday renders that param as an inline notice — this app
// has no global toast system.

import { useEffect, useRef, useState } from "react"
import { Link, useNavigate, useSearchParams } from "react-router-dom"
import { Spinner } from "@/components/ui/spinner"
import { completeMondayOAuth } from "@/lib/monday/api"

// Last resort only — callers always send an explicit `backTo`. This page has no
// org in scope, so it can't name an org-scoped settings route; org home is the
// nearest real one. (It used to be "/settings/monday", which has no route at
// all: every OAuth round trip that fell back here landed on the 404 page.)
const FALLBACK = "/orgs/all"

function withParam(path: string, params: Record<string, string>): string {
  const qs = new URLSearchParams(params).toString()
  return `${path}${path.includes("?") ? "&" : "?"}${qs}`
}

export function MondayOAuthCallback() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const [exchangeError, setExchangeError] = useState<string | null>(null)
  const ranRef = useRef(false)

  const code = searchParams.get("code")
  const state = searchParams.get("state")
  // Derived, not stateful: whether Monday sent us the params is knowable at
  // render time, so it never needs an effect.
  const failed = !code || !state ? "missing code or state" : exchangeError

  useEffect(() => {
    if (ranRef.current || !code || !state) return
    ranRef.current = true

    void completeMondayOAuth(code, state).then((result) => {
      if (result.ok) {
        // Server validates backTo is an app path; keep a client-side guard so
        // a malformed value can never leave the SPA.
        const backTo = result.backTo.startsWith("/") ? result.backTo : FALLBACK
        navigate(withParam(backTo, { monday: "connected" }), { replace: true })
      } else {
        // Reported here rather than bounced onward: a failed exchange has no
        // `backTo` to return to, so redirecting could only guess — and the
        // guess was a route that didn't exist.
        setExchangeError(result.reason)
      }
    })
  }, [navigate, code, state])

  if (failed) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3 px-6 text-center">
        <p className="text-sm font-medium">Couldn't finish connecting to Monday.com</p>
        <p className="text-sm text-muted-foreground">{failed}</p>
        <Link to={FALLBACK} className="text-sm font-medium underline underline-offset-4">
          Back to Aquilla
        </Link>
      </div>
    )
  }

  return (
    <div className="flex h-screen items-center justify-center">
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner /> Connecting to Monday.com…
      </p>
    </div>
  )
}
