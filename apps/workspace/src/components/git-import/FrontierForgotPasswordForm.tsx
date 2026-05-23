import { useState, type FormEvent } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { requestPasswordReset, FrontierAuthError } from "@/lib/frontier/auth"

export function FrontierForgotPasswordForm({ onBack }: { onBack: () => void }) {
  const [email, setEmail] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(false)

  const emailOk = /.+@.+\..+/.test(email.trim())

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      await requestPasswordReset(email.trim())
      setSent(true)
    } catch (err) {
      setError(err instanceof FrontierAuthError ? err.message : "Failed to send reset email")
    } finally {
      setBusy(false)
    }
  }

  if (sent) {
    return (
      <div className="space-y-3">
        <p className="text-sm">
          If an account exists for <span className="font-medium">{email.trim()}</span>, a password reset link has been sent. Check your email and follow the link to choose a new password.
        </p>
        <Button variant="outline" onClick={onBack} className="w-full">
          Back to login
        </Button>
      </div>
    )
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="r-email">Email</Label>
        <Input
          id="r-email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="email"
        />
        <p className="text-xs text-muted-foreground">
          We'll send a link to reset your password.
        </p>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <Button type="submit" disabled={busy || !emailOk} className="w-full">
        {busy ? "Sending…" : "Send reset link"}
      </Button>
      <Button type="button" variant="ghost" onClick={onBack} className="w-full">
        Back to login
      </Button>
    </form>
  )
}
