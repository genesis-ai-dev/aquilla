// apps/login — single-page login form.
//
// On success, redirects to:
//   1. `?return=<url>` if a same-origin return URL was passed in (AD-11
//      handoff contract);
//   2. otherwise `/projects` (the default app per routes.json).
//
// Errors surface verbatim from AuthClientError so the user sees the
// server's intended message ("Incorrect username/email or password" etc.).

import { useState, type FormEvent } from "react"
import {
  login,
  AuthClientError,
  type LoginResult,
} from "@aquilla/auth-client"
import {
  Alert,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  FormRow,
  Input,
} from "@aquilla/ui"
import { Link } from "react-router-dom"
import { resolveRedirect } from "./redirect"

const DEFAULT_REDIRECT = "/projects"

interface LoginAppProps {
  /** Override window for tests. */
  windowImpl?: Window
  /** Override the login function for tests. */
  loginFn?: typeof login
  /**
   * Default redirect target when no `?return=` param is present. Override-
   * able so consumers don't have to monkey-patch the constant in tests.
   */
  defaultRedirect?: string
}

export function App({
  windowImpl,
  loginFn = login,
  defaultRedirect = DEFAULT_REDIRECT,
}: LoginAppProps = {}) {
  const [usernameOrEmail, setUsernameOrEmail] = useState("")
  const [password, setPassword] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (submitting) return
    setError(null)
    setSubmitting(true)
    try {
      const result: LoginResult = await loginFn({
        usernameOrEmail: usernameOrEmail.trim(),
        password,
      })
      void result
      const target = resolveRedirect({
        defaultPath: defaultRedirect,
        windowImpl,
      })
      // Hard-navigate so the new app picks up the cookie set by login().
      // Per AD-11: "navigation between [apps] is a hard URL transition."
      const w = windowImpl ?? window
      w.location.assign(target)
    } catch (err) {
      if (err instanceof AuthClientError) {
        setError(err.message)
      } else if (err instanceof Error) {
        setError(err.message)
      } else {
        setError("Sign in failed")
      }
      setSubmitting(false)
    }
  }

  return (
    <main className="flex min-h-[100vh] items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <Card>
          <CardHeader>
            <CardTitle>Sign in to Aquilla</CardTitle>
            <CardDescription>
              Welcome back. Use your username or email to continue.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form
              className="flex flex-col gap-4"
              onSubmit={handleSubmit}
              data-testid="login-form"
              noValidate
            >
              <FormRow label="Username or email" htmlFor="usernameOrEmail">
                <Input
                  id="usernameOrEmail"
                  name="usernameOrEmail"
                  type="text"
                  autoComplete="username"
                  autoFocus
                  required
                  value={usernameOrEmail}
                  onChange={(e) => setUsernameOrEmail(e.target.value)}
                  disabled={submitting}
                />
              </FormRow>
              <FormRow label="Password" htmlFor="password">
                <Input
                  id="password"
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={submitting}
                />
              </FormRow>

              {error ? (
                <Alert tone="error" role="alert" data-testid="login-error">
                  {error}
                </Alert>
              ) : null}

              <Button
                type="submit"
                fullWidth
                disabled={submitting || !usernameOrEmail || !password}
                data-testid="login-submit"
              >
                {submitting ? "Signing in…" : "Sign in"}
              </Button>
            </form>
          </CardContent>
          <CardFooter className="justify-between text-sm">
            <Link
              to="/forgot"
              data-cross-app="reset"
              className="text-primary hover:underline"
              onClick={(e) => {
                // The reset app lives on a sibling slug, not inside /login/.
                // Intercept and hard-navigate so we leave this Worker.
                e.preventDefault()
                const w = windowImpl ?? window
                w.location.assign("/reset/")
              }}
            >
              Forgot password?
            </Link>
            <a
              href="/signup/"
              data-cross-app="signup"
              className="text-primary hover:underline"
            >
              Create an account
            </a>
          </CardFooter>
        </Card>
      </div>
    </main>
  )
}
