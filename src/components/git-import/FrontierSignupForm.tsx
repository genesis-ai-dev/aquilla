import { useState, useEffect, type FormEvent } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Eye, EyeOff, Check, X } from "lucide-react"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { FrontierAuthError } from "@/lib/frontier/auth"

/** Pure function — exported for unit testing. */
export function checkPasswordRequirements(password: string, email: string) {
  const emailLocal = email.trim().toLowerCase().split("@")[0]
  return {
    minLength: password.length >= 8,
    notContainsEmail:
      emailLocal.length < 3
        ? true
        : !password.toLowerCase().includes(emailLocal),
  }
}

/** Weak/medium/strong heuristic — length + digit + symbol. */
export function passwordStrength(password: string): "weak" | "medium" | "strong" {
  if (password.length === 0) return "weak"
  let score = 0
  if (password.length >= 8) score++
  if (password.length >= 12) score++
  if (/[0-9]/.test(password)) score++
  if (/[^A-Za-z0-9]/.test(password)) score++
  if (score <= 1) return "weak"
  if (score === 2) return "medium"
  return "strong"
}

function PasswordChecklist({ password, email }: { password: string; email: string }) {
  const checks = checkPasswordRequirements(password, email)
  const strength = passwordStrength(password)
  const hasTyped = password.length > 0

  const strengthColor = {
    weak: "bg-destructive",
    medium: "bg-yellow-400",
    strong: "bg-green-500",
  }[strength]

  const strengthWidth = { weak: "w-1/3", medium: "w-2/3", strong: "w-full" }[strength]

  const items: { key: keyof typeof checks; label: string }[] = [
    { key: "minLength", label: "At least 8 characters" },
    { key: "notContainsEmail", label: "Does not contain your email" },
  ]

  return (
    <div className="mt-1.5 space-y-1">
      {items.map(({ key, label }) => {
        const ok = checks[key]
        return (
          <div key={key} className="flex items-center gap-1.5 text-xs">
            {ok ? (
              <Check className="h-3 w-3 text-green-500 shrink-0" />
            ) : (
              <X className="h-3 w-3 text-muted-foreground shrink-0" />
            )}
            <span className={ok ? "text-green-600" : "text-muted-foreground"}>{label}</span>
          </div>
        )
      })}
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

export function FrontierSignupForm({ onSuccess }: { onSuccess: () => void }) {
  const { register } = useFrontierSession()
  const [username, setUsername] = useState("")
  const [email, setEmail] = useState("")
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

  // Server enforces: username 3-50 chars, email format, password >= 8 chars.
  const usernameOk = username.trim().length >= 3 && username.trim().length <= 50
  const emailOk = /.+@.+\..+/.test(email.trim())
  const pwChecks = checkPasswordRequirements(password, email)
  const passwordOk = pwChecks.minLength && pwChecks.notContainsEmail
  const canSubmit = usernameOk && emailOk && passwordOk && !busy && isOnline

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
      {!isOnline && (
        <p className="rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
          You're offline — connect to sign in
        </p>
      )}
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
        <div className="relative">
          <Input
            id="s-pass"
            type={showPassword ? "text" : "password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            minLength={8}
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
        <PasswordChecklist password={password} email={email} />
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <Button type="submit" disabled={!canSubmit} className="w-full">
        {busy ? "Creating account…" : "Create account"}
      </Button>
    </form>
  )
}
