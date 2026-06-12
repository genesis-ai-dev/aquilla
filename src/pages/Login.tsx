import { useState, type FormEvent } from "react"
import { useNavigate, useSearchParams } from "react-router-dom"
import { Eye, EyeOff } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { FrontierAuthError } from "@/lib/frontier/auth"
import { FrontierForgotPasswordForm } from "@/components/git-import/FrontierForgotPasswordForm"

type Mode = "login" | "forgot"

export function Login() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const { login } = useFrontierSession()

  const rawNext = searchParams.get("next") ?? ""
  const next = rawNext.startsWith("/") ? rawNext : "/"

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
      navigate(next, { replace: true })
    } catch (err) {
      setError(err instanceof FrontierAuthError ? err.message : "Login failed")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-8">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <h1 className="text-center text-2xl font-semibold">
          {mode === "login" ? "Sign in" : "Reset your password"}
        </h1>

        {mode === "forgot" ? (
          <FrontierForgotPasswordForm onBack={() => setMode("login")} />
        ) : (
          <form onSubmit={onSubmit} className="flex flex-col gap-4">
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="login-user">
                  Username or email
                </FieldLabel>
                <Input
                  id="login-user"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoComplete="username"
                  autoFocus
                />
              </Field>
              <Field>
                <div className="flex items-center justify-between">
                  <FieldLabel htmlFor="login-pass">Password</FieldLabel>
                  <button
                    type="button"
                    onClick={() => setMode("forgot")}
                    className="text-xs text-muted-foreground underline-offset-4 hover:underline"
                  >
                    Forgot password?
                  </button>
                </div>
                <InputGroup>
                  <InputGroupInput
                    id="login-pass"
                    type={showPassword ? "text" : "password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="current-password"
                  />
                  <InputGroupAddon align="inline-end">
                    <InputGroupButton
                      size="icon-xs"
                      onClick={() => setShowPassword((v) => !v)}
                      aria-label={
                        showPassword ? "Hide password" : "Show password"
                      }
                    >
                      {showPassword ? <EyeOff /> : <Eye />}
                    </InputGroupButton>
                  </InputGroupAddon>
                </InputGroup>
              </Field>
            </FieldGroup>
            {error && <FieldError>{error}</FieldError>}
            <Button
              type="submit"
              disabled={busy || !username || !password}
              className="w-full"
            >
              {busy && <Spinner data-icon="inline-start" />}
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
