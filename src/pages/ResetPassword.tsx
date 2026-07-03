/**
 * FRO-270: /reset-password page
 *
 * Reads `token` + `username` from the query string (set by the auth-worker when
 * it sends the reset email). On mount it verifies the token is still valid; if
 * expired/invalid it shows recovery copy with a pre-filled "request a new link"
 * form. On valid token it shows the new-password form; on success it signs the
 * user in and redirects to `/`.
 *
 * Server contract (auth-worker/src/routes/auth.ts):
 *   POST /api/v2/auth/password-reset/verify   { token, username }  → 200/400
 *   POST /api/v2/auth/password-reset/reset    { token, username, new_password } → 200/400/500
 *   POST /api/v2/auth/password-reset/request  { email }            → 200 (existing)
 *
 * Route roots use min-h-screen + document scroll (per scroll-model rule).
 */

import { useState, useEffect, type FormEvent } from "react"
import { useNavigate, useSearchParams } from "react-router-dom"
import { Check, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { RevealableInput } from "@/components/ui/revealable-input"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import {
  verifyResetToken,
  resetPassword,
  requestPasswordReset,
  FrontierAuthError,
} from "@/lib/frontier/auth"
import {
  checkPasswordRequirements,
  passwordStrength,
} from "@/components/git-import/FrontierSignupForm"

// ---------------------------------------------------------------------------
// Inline password checklist (same logic as signup, but standalone here so the
// signup form module doesn't need to export its private component).
// ---------------------------------------------------------------------------
function PasswordChecklist({ password }: { password: string }) {
  const checks = checkPasswordRequirements(password, "")
  const strength = passwordStrength(password)
  const hasTyped = password.length > 0

  const strengthColor = {
    weak: "bg-destructive",
    medium: "bg-yellow-400",
    strong: "bg-green-500",
  }[strength]

  const strengthWidth = {
    weak: "w-1/3",
    medium: "w-2/3",
    strong: "w-full",
  }[strength]

  return (
    <div className="mt-1.5 space-y-1">
      <div className="flex items-center gap-1.5 text-xs">
        {checks.minLength ? (
          <Check className="h-3 w-3 text-green-500 shrink-0" />
        ) : (
          <X className="h-3 w-3 text-muted-foreground shrink-0" />
        )}
        <span className={checks.minLength ? "text-green-600" : "text-muted-foreground"}>
          At least 8 characters
        </span>
      </div>
      {hasTyped && (
        <div className="mt-1 space-y-0.5">
          <div className="h-1 w-full rounded bg-muted overflow-hidden">
            <div className={`h-full rounded transition-all ${strengthColor} ${strengthWidth}`} />
          </div>
          <p className="text-[10px] text-muted-foreground capitalize">Strength: {strength}</p>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Recovery form — shown when the token is invalid/expired.
// ---------------------------------------------------------------------------
function TokenExpiredView({ username }: { username: string }) {
  const [email, setEmail] = useState("")
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const emailOk = /.+@.+\..+/.test(email.trim())

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      await requestPasswordReset(email.trim())
      setSent(true)
    } catch (err) {
      setError(
        err instanceof FrontierAuthError ? err.message : "Failed to send reset email",
      )
    } finally {
      setBusy(false)
    }
  }

  if (sent) {
    return (
      <div className="space-y-3">
        <p className="text-sm">
          A new reset link has been sent to{" "}
          <span className="font-medium">{email.trim()}</span>. Check your inbox and
          follow the link to choose a new password.
        </p>
        <a
          href="/"
          className="inline-flex w-full items-center justify-center rounded-xl border px-3 py-1.5 text-sm font-medium transition-all hover:bg-muted"
        >
          Back to app
        </a>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="rounded-md bg-muted px-4 py-3 text-sm text-muted-foreground">
        This reset link has expired or is invalid. Enter your email address to
        request a new one
        {username ? (
          <>
            {" "}
            for account <span className="font-medium text-foreground">{username}</span>
          </>
        ) : null}
        .
      </div>
      <form onSubmit={onSubmit} className="space-y-3">
        <div>
          <Label htmlFor="rp-email">Email</Label>
          <Input
            id="rp-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
          />
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <Button type="submit" disabled={busy || !emailOk} className="w-full">
          {busy ? "Sending…" : "Request a new link"}
        </Button>
        <a
          href="/"
          className="inline-flex w-full items-center justify-center text-sm text-muted-foreground hover:underline underline-offset-4"
        >
          Back to app
        </a>
      </form>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main reset form — shown when token is valid.
// ---------------------------------------------------------------------------
type VerifyState = "loading" | "valid" | "invalid"

export function ResetPassword() {
  const navigate = useNavigate()
  const { login } = useFrontierSession()
  const [searchParams] = useSearchParams()

  const token = searchParams.get("token") ?? ""
  const username = searchParams.get("username") ?? ""

  const [verifyState, setVerifyState] = useState<VerifyState>("loading")
  const [password, setPassword] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Verify token on mount
  useEffect(() => {
    if (!token || !username) {
      setVerifyState("invalid")
      return
    }
    let cancelled = false
    void verifyResetToken(token, username).then(
      () => {
        if (!cancelled) setVerifyState("valid")
      },
      () => {
        if (!cancelled) setVerifyState("invalid")
      },
    )
    return () => {
      cancelled = true
    }
  }, [token, username])

  const pwChecks = checkPasswordRequirements(password, "")
  const passwordOk = pwChecks.minLength

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (!passwordOk) return
    setError(null)
    setBusy(true)
    try {
      await resetPassword(token, username, password)
      // Sign the user in with their new password so they land authenticated.
      await login(username, password)
      navigate("/", { replace: true })
    } catch (err) {
      setError(
        err instanceof FrontierAuthError ? err.message : "Failed to reset password",
      )
      setBusy(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-8">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center space-y-1">
          <h1 className="text-2xl font-semibold">Reset your password</h1>
          {username && (
            <p className="text-sm text-muted-foreground">
              Account: <span className="font-medium text-foreground">{username}</span>
            </p>
          )}
        </div>

        {verifyState === "loading" && (
          <p className="text-center text-sm text-muted-foreground">Verifying link…</p>
        )}

        {verifyState === "invalid" && <TokenExpiredView username={username} />}

        {verifyState === "valid" && (
          <form onSubmit={onSubmit} className="space-y-4">
            <div>
              <Label htmlFor="rp-new-password">New password</Label>
              <RevealableInput
                id="rp-new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
                minLength={8}
                autoFocus
              />
              <PasswordChecklist password={password} />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button type="submit" disabled={busy || !passwordOk} className="w-full">
              {busy ? "Setting password…" : "Set new password"}
            </Button>
          </form>
        )}
      </div>
    </div>
  )
}
