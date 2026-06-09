// Dev-only logout helper.
//
// Navigate to `/__dev/logout` to clear the current session and land on the
// onboarding wizard — useful for testing the sign-in UI without manually
// clearing IDB + cookies in DevTools.
//
// Gated on `import.meta.env.DEV` to match DevLoginRoute.

import { useEffect } from "react"
import { useNavigate } from "react-router-dom"
import { useFrontierSession } from "@/hooks/useFrontierSession"

export function DevLogoutRoute() {
  const navigate = useNavigate()
  const { logout } = useFrontierSession()

  useEffect(() => {
    if (!import.meta.env.DEV) {
      navigate("/", { replace: true })
      return
    }
    void logout().then(() => {
      navigate("/onboarding", { replace: true })
    })
  }, [logout, navigate])

  return (
    <div className="flex h-screen items-center justify-center p-6">
      <div className="max-w-md space-y-2 text-center">
        <h1 className="text-lg font-semibold">Signing out…</h1>
        <p className="text-sm text-muted-foreground">Clearing session and redirecting.</p>
      </div>
    </div>
  )
}
