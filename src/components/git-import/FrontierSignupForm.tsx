import { useState, useEffect, type FormEvent } from "react"
import { Button } from "@/components/ui/button"
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Check, X } from "lucide-react"
import { RevealableInput } from "@/components/ui/revealable-input"
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

export function FrontierSignupForm({
  onSuccess,
  initialEmail,
}: {
  onSuccess: () => void
  /** AQU-338: seed the email field (e.g. the recipient email an invite is
   *  bound to). Optional — omit for the plain signup surface. */
  initialEmail?: string | null
}) {
  const { register } = useFrontierSession()
  const [username, setUsername] = useState("")
  const [email, setEmail] = useState(initialEmail ?? "")
  const [emailEdited, setEmailEdited] = useState(false)
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

  // AQU-338: the invite preview can resolve after this form mounts, so adopt a
  // late-arriving prefill — but stop once the user edits the field, so we never
  // clobber what they typed.
  useEffect(() => {
    if (!emailEdited && initialEmail) setEmail(initialEmail)
  }, [initialEmail, emailEdited])

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
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="s-user">Username</FieldLabel>
          <Input
            id="s-user"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            minLength={3}
            maxLength={50}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="s-email">Email</FieldLabel>
          <Input
            id="s-email"
            type="email"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value)
              setEmailEdited(true)
            }}
            autoComplete="email"
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="s-pass">Password</FieldLabel>
          <RevealableInput
            id="s-pass"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            minLength={8}
          />
          <PasswordChecklist password={password} email={email} />
        </Field>
      </FieldGroup>
      {error && <FieldError>{error}</FieldError>}
      <Button type="submit" disabled={!canSubmit} className="w-full">
        {busy ? "Creating account…" : "Create account"}
      </Button>
    </form>
  )
}
