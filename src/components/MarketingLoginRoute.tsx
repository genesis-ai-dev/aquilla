// Marketing/demo auto-login landing page.
//
// Navigate to `/__marketing/login` to land in a logged-in session as the
// curated `demo` user and get bounced to the populated demo project. Used by
// showcase recordings and by a public/staging demo deployment.
//
// NOT gated on import.meta.env.DEV (unlike DevLoginRoute) — the curated demo
// runs in production-like builds (the recording harness uses `vite build`).
// The real gate is server-side: /__marketing__/login 404s unless the
// auth-worker has it enabled, in which case marketingLogin() returns null and
// we show "demo unavailable" rather than a blank screen.

import { useEffect, useState } from "react"
import { useNavigate } from "react-router-dom"
import { marketingLogin } from "@/lib/frontier/auth"

// Mirrors M_PROJECT_ID in auth-worker/src/routes/marketing-seed.ts.
const DEMO_PROJECT_ID = "demo-john"

export function MarketingLoginRoute() {
  const navigate = useNavigate()
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const session = await marketingLogin()
        if (cancelled) return
        if (!session) {
          setError("Demo is unavailable in this environment.")
          return
        }
        navigate(`/project/${DEMO_PROJECT_ID}`, { replace: true })
      } catch (e) {
        if (cancelled) return
        setError(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [navigate])

  return (
    <div className="flex h-screen items-center justify-center p-6">
      <div className="max-w-md space-y-2 text-center">
        <h1 className="text-lg font-semibold">Loading the Aquilla demo…</h1>
        {error ? (
          <p className="text-sm text-red-600" data-testid="marketing-login-error">
            {error}
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">Setting up a curated project for you.</p>
        )}
      </div>
    </div>
  )
}
