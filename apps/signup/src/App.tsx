// apps/signup — create-account form.
//
// On success, hard-navigates to `?return=` (same-origin only) or
// `/projects`. Same submit/error pattern as apps/login.

import { useState, type FormEvent } from "react"
import { signup, AuthClientError } from "@aquilla/auth-client"
import {
  Alert,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  FloatingThemeToggle,
  FormRow,
  Input,
} from "@aquilla/ui"
import { resolveRedirect } from "./redirect"

const DEFAULT_REDIRECT = "/projects"

interface ValidationError {
  field: "username" | "email" | "password" | "confirm"
  message: string
}

function validate(args: {
  username: string
  email: string
  password: string
  confirm: string
}): ValidationError[] {
  const errs: ValidationError[] = []
  if (args.username.length < 3) {
    errs.push({ field: "username", message: "At least 3 characters." })
  } else if (args.username.length > 50) {
    errs.push({ field: "username", message: "Too long (max 50)." })
  }
  // Light email shape check — server is the authority.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(args.email)) {
    errs.push({ field: "email", message: "Doesn't look like an email." })
  }
  if (args.password.length < 8) {
    errs.push({ field: "password", message: "At least 8 characters." })
  }
  if (args.confirm !== args.password) {
    errs.push({ field: "confirm", message: "Passwords don't match." })
  }
  return errs
}

interface SignupAppProps {
  windowImpl?: Window
  signupFn?: typeof signup
  defaultRedirect?: string
}

export function App({
  windowImpl,
  signupFn = signup,
  defaultRedirect = DEFAULT_REDIRECT,
}: SignupAppProps = {}) {
  const [username, setUsername] = useState("")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [confirm, setConfirm] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)
  const [showValidation, setShowValidation] = useState(false)

  const validation = validate({ username, email, password, confirm })
  const errorByField = (f: ValidationError["field"]): string | undefined =>
    showValidation
      ? validation.find((v) => v.field === f)?.message
      : undefined

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (submitting) return
    setServerError(null)
    if (validation.length > 0) {
      setShowValidation(true)
      return
    }
    setSubmitting(true)
    try {
      await signupFn({
        username: username.trim(),
        email: email.trim(),
        password,
      })
      const target = resolveRedirect({
        defaultPath: defaultRedirect,
        windowImpl,
      })
      const w = windowImpl ?? window
      w.location.assign(target)
    } catch (err) {
      if (err instanceof AuthClientError) {
        setServerError(err.message)
      } else if (err instanceof Error) {
        setServerError(err.message)
      } else {
        setServerError("Sign up failed")
      }
      setSubmitting(false)
    }
  }

  return (
    <main className="flex min-h-[100vh] items-center justify-center px-4 py-12">
      <FloatingThemeToggle />
      <div className="w-full max-w-sm">
        <Card>
          <CardHeader>
            <CardTitle>Create your Aquilla account</CardTitle>
            <CardDescription>
              Pick a username, drop your email, set a password.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form
              className="flex flex-col gap-4"
              onSubmit={handleSubmit}
              data-testid="signup-form"
              noValidate
            >
              <FormRow
                label="Username"
                htmlFor="username"
                hint="3–50 characters."
                error={errorByField("username")}
              >
                <Input
                  id="username"
                  name="username"
                  type="text"
                  autoComplete="username"
                  autoFocus
                  required
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  disabled={submitting}
                  aria-invalid={!!errorByField("username")}
                />
              </FormRow>
              <FormRow
                label="Email"
                htmlFor="email"
                error={errorByField("email")}
              >
                <Input
                  id="email"
                  name="email"
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  disabled={submitting}
                  aria-invalid={!!errorByField("email")}
                />
              </FormRow>
              <FormRow
                label="Password"
                htmlFor="password"
                hint="At least 8 characters."
                error={errorByField("password")}
              >
                <Input
                  id="password"
                  name="password"
                  type="password"
                  autoComplete="new-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={submitting}
                  aria-invalid={!!errorByField("password")}
                />
              </FormRow>
              <FormRow
                label="Confirm password"
                htmlFor="confirm"
                error={errorByField("confirm")}
              >
                <Input
                  id="confirm"
                  name="confirm"
                  type="password"
                  autoComplete="new-password"
                  required
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  disabled={submitting}
                  aria-invalid={!!errorByField("confirm")}
                />
              </FormRow>

              {serverError ? (
                <Alert tone="error" role="alert" data-testid="signup-error">
                  {serverError}
                </Alert>
              ) : null}

              <Button
                type="submit"
                fullWidth
                disabled={
                  submitting || !username || !email || !password || !confirm
                }
                data-testid="signup-submit"
              >
                {submitting ? "Creating account…" : "Create account"}
              </Button>
            </form>
          </CardContent>
          <CardFooter className="justify-center text-sm">
            <span className="text-muted-foreground">
              Already have an account?{" "}
              <a href="/login/" className="text-primary hover:underline">
                Sign in
              </a>
            </span>
          </CardFooter>
        </Card>
      </div>
    </main>
  )
}
