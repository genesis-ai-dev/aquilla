// /oauth/callback — Monday.com OAuth landing page.
//
// Monday's registered redirect URI points at this SPA route (not the worker).
// On mount we forward `code` + `state` to the auth-worker's exchange endpoint
// exactly once (the code is single-use — a ref guards React strict-mode's
// double effect), then bounce to `backTo` with a `?monday=connected|error`
// param. OrgSettingsMonday renders that param as an inline notice — this app
// has no global toast system.

import { useEffect, useRef, useState } from "react"
import { useNavigate, useSearchParams } from "react-router-dom"
import { Spinner } from "@/components/ui/spinner"
import { completeMondayOAuth } from "@/lib/monday/api"

const FALLBACK = "/settings/monday"

function withParam(path: string, params: Record<string, string>): string {
  const qs = new URLSearchParams(params).toString()
  return `${path}${path.includes("?") ? "&" : "?"}${qs}`
}

export function MondayOAuthCallback() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const [failed, setFailed] = useState(false)
  const ranRef = useRef(false)

  useEffect(() => {
    if (ranRef.current) return
    ranRef.current = true

    const code = searchParams.get("code")
    const state = searchParams.get("state")
    if (!code || !state) {
      navigate(withParam(FALLBACK, { monday: "error", reason: "missing code or state" }), {
        replace: true,
      })
      return
    }

    void completeMondayOAuth(code, state).then((result) => {
      if (result.ok) {
        // Server validates backTo is an app path; keep a client-side guard so
        // a malformed value can never leave the SPA.
        const backTo = result.backTo.startsWith("/") ? result.backTo : FALLBACK
        navigate(withParam(backTo, { monday: "connected" }), { replace: true })
      } else {
        setFailed(true)
        navigate(withParam(FALLBACK, { monday: "error", reason: result.reason }), {
          replace: true,
        })
      }
    })
  }, [navigate, searchParams])

  return (
    <div className="flex h-screen items-center justify-center">
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner /> {failed ? "Redirecting…" : "Connecting to Monday.com…"}
      </p>
    </div>
  )
}
