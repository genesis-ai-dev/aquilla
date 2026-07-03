import { useState, useEffect, type FormEvent } from "react"
import { useNavigate } from "react-router-dom"
import { Button } from "@/components/ui/button"
import {
  Field,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { RevealableInput } from "@/components/ui/revealable-input"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { FrontierAuthError } from "@/lib/frontier/auth"

export function FrontierLoginForm({
  onSuccess,
  onForgotPassword,
  returnTo,
}: {
  onSuccess: () => void
  onForgotPassword?: () => void
  /** If provided, navigate here after a successful login. */
  returnTo?: string
}) {
  const { login } = useFrontierSession()
  const navigate = useNavigate()
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
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
      if (returnTo) navigate(returnTo)
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
      <FieldGroup className="gap-3">
        <Field>
          <FieldLabel htmlFor="f-user">Aquilla username or email</FieldLabel>
          <Input
            id="f-user"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
          />
        </Field>
        <Field>
          <div className="flex items-center justify-between">
            <FieldLabel htmlFor="f-pass">Password</FieldLabel>
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
          <RevealableInput
            id="f-pass"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
        </Field>
      </FieldGroup>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <Button type="submit" disabled={busy || !username || !password || !isOnline} className="w-full">
        {busy ? "Logging in…" : "Log in"}
      </Button>
    </form>
  )
}
