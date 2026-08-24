// Dev-only auto-login landing page.
//
// Agents (and humans) navigate to `/__dev/login` to land in a logged-in
// browser session as the seeded `dev` user, then get bounced to the seeded
// `dev-project`. Removes the "open SignIn, click the dev button" round trip
// that makes Playwright MCP loops verbose.
//
// Gated on `import.meta.env.DEV` — in a prod build the route renders a 404
// shell, and the underlying /__dev__/login endpoint 404s anyway because
// WRANGLER_LOCAL isn't set in prod auth-worker.

import { useEffect, useState } from "react"
import { useNavigate, useSearchParams } from "react-router-dom"
import { devLogin } from "@/lib/frontier/auth"

export function DevLoginRoute() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const as = searchParams.get("as")?.trim() || "dev"
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!import.meta.env.DEV) {
      setError("dev login is disabled in production builds")
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const session = await devLogin(as)
        if (cancelled) return
        if (!session) {
          setError(
            "dev login endpoint unavailable — is the auth-worker running with WRANGLER_LOCAL=1?",
          )
          return
        }
        const dest =
          as === "carol"
            ? "/project/dev-project/settings/general"
            : "/project/dev-project/editor"
        navigate(dest, { replace: true })
      } catch (e) {
        if (cancelled) return
        setError(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [as, navigate])

  return (
    <div className="flex h-screen items-center justify-center p-6">
      <div className="max-w-md space-y-2 text-center">
        <h1 className="text-lg font-semibold">Dev auto-login</h1>
        {error ? (
          <p className="text-sm text-red-600" data-testid="dev-login-error">
            {error}
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">Signing in as {as}…</p>
        )}
      </div>
    </div>
  )
}
