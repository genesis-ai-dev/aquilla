import { useState, type FormEvent } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { FrontierAuthError } from "@/lib/frontier/auth"

export function FrontierSignupForm({ onSuccess }: { onSuccess: () => void }) {
  const { register } = useFrontierSession()
  const [username, setUsername] = useState("")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Server enforces: username 3-50 chars, email format, password >= 8 chars.
  const usernameOk = username.trim().length >= 3 && username.trim().length <= 50
  const emailOk = /.+@.+\..+/.test(email.trim())
  const passwordOk = password.length >= 8
  const canSubmit = usernameOk && emailOk && passwordOk && !busy

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      await register(username.trim(), email.trim(), password)
      onSuccess()
    } catch (err) {
      setError(err instanceof FrontierAuthError ? err.message : "Sign up failed")
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <div>
        <Label htmlFor="s-user">Username</Label>
        <Input
          id="s-user"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="username"
          minLength={3}
          maxLength={50}
        />
      </div>
      <div>
        <Label htmlFor="s-email">Email</Label>
        <Input
          id="s-email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="email"
        />
      </div>
      <div>
        <Label htmlFor="s-pass">Password</Label>
        <Input
          id="s-pass"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password"
          minLength={8}
        />
        <p className="mt-1 text-xs text-muted-foreground">
          At least 8 characters. Choose something strong and unique.
        </p>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <Button type="submit" disabled={!canSubmit} className="w-full">
        {busy ? "Creating account…" : "Create account"}
      </Button>
    </form>
  )
}
