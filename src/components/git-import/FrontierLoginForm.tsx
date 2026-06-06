import { useState, useEffect, type FormEvent } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Eye, EyeOff } from "lucide-react"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { FrontierAuthError } from "@/lib/frontier/auth"

export function FrontierLoginForm({
  onSuccess,
  onForgotPassword,
}: {
  onSuccess: () => void
  onForgotPassword?: () => void
}) {
  const { login } = useFrontierSession()
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [isOnline, setIsOnline] = useState(() => navigator.onLine)

  useEffect(() => {
    const handleOnline = () => setIsOnline(true)
    const handleOffline = () => setIsOnline(false)
    window.addEventListener("online", handleOnline)
    window.addEventListener("offline", handleOffline)
    return () => {
      window.removeEventListener("online", handleOnline)
      window.removeEventListener("offline", handleOffline)
    }
  }, [])

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      await login(username, password)
      onSuccess()
    } catch (err) {
      setError(err instanceof FrontierAuthError ? err.message : "Login failed")
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      {!isOnline && (
        <p className="rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
          You're offline — connect to sign in
        </p>
      )}
      <div>
        <Label htmlFor="f-user">Aquilla username or email</Label>
        <Input id="f-user" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" />
      </div>
      <div>
        <div className="flex items-center justify-between">
          <Label htmlFor="f-pass">Password</Label>
          {onForgotPassword && (
            <button
              type="button"
              onClick={onForgotPassword}
              className="text-xs text-muted-foreground underline-offset-4 hover:underline"
            >
              Forgot password?
            </button>
          )}
        </div>
        <div className="relative">
          <Input
            id="f-pass"
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
      <Button type="submit" disabled={busy || !username || !password || !isOnline} className="w-full">
        {busy ? "Logging in…" : "Log in"}
      </Button>
    </form>
  )
}
