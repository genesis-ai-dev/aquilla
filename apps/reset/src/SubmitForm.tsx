// /reset/:token — step 2: new password entry.
//
// The auth-worker reset URL carries `?token=<t>&username=<u>`, so we
// accept the token from EITHER the path param (route-shape /reset/:token)
// or the query string. Username always comes from the query string.

import { useEffect, useState, type FormEvent } from "react"
import { useParams, useSearchParams } from "react-router-dom"
import {
  submitPasswordReset,
  verifyPasswordResetToken,
  AuthClientError,
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

interface SubmitFormProps {
  submitFn?: typeof submitPasswordReset
  verifyFn?: typeof verifyPasswordResetToken
  windowImpl?: Window
  /** Override token (otherwise read from path/query). Test-only. */
  overrideToken?: string
  /** Override username (otherwise read from query). Test-only. */
  overrideUsername?: string
}

type VerifyState = "checking" | "ok" | "invalid" | "skipped"

export function SubmitForm({
  submitFn = submitPasswordReset,
  verifyFn = verifyPasswordResetToken,
  windowImpl,
  overrideToken,
  overrideUsername,
}: SubmitFormProps = {}) {
  const params = useParams<{ token?: string }>()
  const [searchParams] = useSearchParams()

  const token = overrideToken ?? params.token ?? searchParams.get("token") ?? ""
  const username = overrideUsername ?? searchParams.get("username") ?? ""

  const [password, setPassword] = useState("")
  const [confirm, setConfirm] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [verifyState, setVerifyState] = useState<VerifyState>(
    token && username ? "checking" : "skipped",
  )

  useEffect(() => {
    // Initial state already accounts for missing token/username via the
    // useState initializer; nothing to do in that case.
    if (!token || !username) return
    let cancelled = false
    verifyFn({ token, username })
      .then((ok) => {
        if (cancelled) return
        setVerifyState(ok ? "ok" : "invalid")
      })
      .catch(() => {
        if (!cancelled) setVerifyState("invalid")
      })
    return () => {
      cancelled = true
    }
  }, [token, username, verifyFn])

  function localValidationError(): string | null {
    if (password.length < 8) return "Password must be at least 8 characters."
    if (confirm !== password) return "Passwords don't match."
    return null
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (submitting) return
    setError(null)
    const v = localValidationError()
    if (v) {
      setError(v)
      return
    }
    setSubmitting(true)
    try {
      await submitFn({ token, username, newPassword: password })
      // Hard-navigate to /login/ so the user re-authenticates with the
      // fresh password. Per AD-11: navigation between apps is hard URL.
      const w = windowImpl ?? window
      w.location.assign("/login/?reset=1")
    } catch (err) {
      if (err instanceof AuthClientError) {
        setError(err.message)
      } else if (err instanceof Error) {
        setError(err.message)
      } else {
        setError("Reset failed")
      }
      setSubmitting(false)
    }
  }

  if (!token || !username) {
    return (
      <main className="flex min-h-[100vh] items-center justify-center px-4 py-12">
        <div className="w-full max-w-sm">
          <Card>
            <CardHeader>
              <CardTitle>Reset link is incomplete</CardTitle>
              <CardDescription>
                The link is missing the token or username. Request a fresh
                reset link to continue.
              </CardDescription>
            </CardHeader>
            <CardFooter className="justify-center text-sm">
              <a href="/reset/" className="text-primary hover:underline">
                Request a new reset link
              </a>
            </CardFooter>
          </Card>
        </div>
      </main>
    )
  }

  if (verifyState === "invalid") {
    return (
      <main className="flex min-h-[100vh] items-center justify-center px-4 py-12">
        <div className="w-full max-w-sm">
          <Card>
            <CardHeader>
              <CardTitle>This reset link is invalid or expired</CardTitle>
              <CardDescription>
                Reset links expire after 24 hours. Request a fresh link to
                continue.
              </CardDescription>
            </CardHeader>
            <CardFooter className="justify-center text-sm">
              <a href="/reset/" className="text-primary hover:underline">
                Request a new reset link
              </a>
            </CardFooter>
          </Card>
        </div>
      </main>
    )
  }

  return (
    <main className="flex min-h-[100vh] items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <Card>
          <CardHeader>
            <CardTitle>Set a new password</CardTitle>
            <CardDescription>
              You're resetting the password for <strong>{username}</strong>.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form
              className="flex flex-col gap-4"
              onSubmit={handleSubmit}
              data-testid="reset-submit-form"
              noValidate
            >
              <FormRow
                label="New password"
                htmlFor="password"
                hint="At least 8 characters."
              >
                <Input
                  id="password"
                  name="password"
                  type="password"
                  autoComplete="new-password"
                  autoFocus
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={submitting || verifyState === "checking"}
                />
              </FormRow>
              <FormRow label="Confirm new password" htmlFor="confirm">
                <Input
                  id="confirm"
                  name="confirm"
                  type="password"
                  autoComplete="new-password"
                  required
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  disabled={submitting || verifyState === "checking"}
                />
              </FormRow>

              {error ? (
                <Alert tone="error" role="alert" data-testid="reset-error">
                  {error}
                </Alert>
              ) : null}

              <Button
                type="submit"
                fullWidth
                disabled={
                  submitting ||
                  verifyState === "checking" ||
                  !password ||
                  !confirm
                }
                data-testid="reset-submit"
              >
                {submitting ? "Resetting…" : "Reset password"}
              </Button>
            </form>
          </CardContent>
          <CardFooter className="justify-center text-sm">
            <a href="/login/" className="text-primary hover:underline">
              Back to sign in
            </a>
          </CardFooter>
        </Card>
      </div>
    </main>
  )
}
