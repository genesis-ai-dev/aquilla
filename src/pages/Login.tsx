/**
 * FRO-282: /login page
 *
 * Dedicated login page for returning users — avoids the onboarding wizard
 * defaulting to signup. On success, navigates to `/` (dashboard).
 *
 * Links:
 *  - "Forgot password?" → /reset-password (FRO-270)
 *  - "New here?" → /onboarding (signup wizard)
 *
 * Route root: min-h-screen + document scroll (per scroll-model rule).
 */

import { useState, type FormEvent } from "react"
import { useNavigate } from "react-router-dom"
import { Eye, EyeOff } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { FrontierAuthError } from "@/lib/frontier/auth"
import { FrontierForgotPasswordForm } from "@/components/git-import/FrontierForgotPasswordForm"

type Mode = "login" | "forgot"

export function Login() {
  const navigate = useNavigate()
  const { login } = useFrontierSession()

  const [mode, setMode] = useState<Mode>("login")
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      await login(username, password)
      navigate("/", { replace: true })
    } catch (err) {
      setError(err instanceof FrontierAuthError ? err.message : "Login failed")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-8">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center space-y-1">
          <h1 className="text-2xl font-semibold">
            {mode === "login" ? "Sign in to Aquilla" : "Reset your password"}
          </h1>
          {mode === "login" && (
            <p className="text-sm text-muted-foreground">
              Welcome back — enter your credentials to continue.
            </p>
          )}
        </div>

        {mode === "forgot" ? (
          <FrontierForgotPasswordForm onBack={() => setMode("login")} />
        ) : (
          <form onSubmit={onSubmit} className="space-y-4">
            <div>
              <Label htmlFor="login-user">Aquilla username or email</Label>
              <Input
                id="login-user"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                autoFocus
              />
            </div>
            <div>
              <div className="flex items-center justify-between">
                <Label htmlFor="login-pass">Password</Label>
                <button
                  type="button"
                  onClick={() => setMode("forgot")}
                  className="text-xs text-muted-foreground underline-offset-4 hover:underline"
                >
                  Forgot password?
                </button>
              </div>
              <div className="relative">
                <Input
                  id="login-pass"
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  className="pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  className="absolute inset-y-0 right-0 flex items-center px-3 text-muted-foreground hover:text-foreground"
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button
              type="submit"
              disabled={busy || !username || !password}
              className="w-full"
            >
              {busy ? "Signing in…" : "Sign in"}
            </Button>
          </form>
        )}

        {mode === "login" && (
          <p className="text-center text-sm text-muted-foreground">
            New here?{" "}
            <a
              href="/onboarding"
              className="font-medium text-foreground underline-offset-4 hover:underline"
            >
              Create an account
            </a>
          </p>
        )}
      </div>
    </div>
  )
}
