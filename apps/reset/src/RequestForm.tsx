// /reset/ — step 1: email entry.
//
// On submit we POST to `/api/v2/auth/password-reset/request`. The server
// intentionally always responds 2xx (never discloses whether the email is
// registered), so we show "Check your email" regardless of whether the
// account exists.

import { useState, type FormEvent } from "react"
import {
  requestPasswordReset,
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
  FloatingThemeToggle,
  FormRow,
  Input,
} from "@aquilla/ui"

interface RequestFormProps {
  requestFn?: typeof requestPasswordReset
}

export function RequestForm({
  requestFn = requestPasswordReset,
}: RequestFormProps = {}) {
  const [email, setEmail] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState(false)

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (submitting) return
    setError(null)
    setSubmitting(true)
    try {
      await requestFn(email.trim())
      setSent(true)
    } catch (err) {
      if (err instanceof AuthClientError) {
        setError(err.message)
      } else if (err instanceof Error) {
        setError(err.message)
      } else {
        setError("Reset request failed")
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="flex min-h-[100vh] items-center justify-center px-4 py-12">
      <FloatingThemeToggle />
      <div className="w-full max-w-sm">
        <Card>
          <CardHeader>
            <CardTitle>Reset your password</CardTitle>
            <CardDescription>
              Enter your account email and we'll send you a reset link.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {sent ? (
              <Alert tone="success" data-testid="reset-sent">
                Check your email. If an account exists for{" "}
                <strong>{email}</strong>, we sent a reset link there.
              </Alert>
            ) : (
              <form
                className="flex flex-col gap-4"
                onSubmit={handleSubmit}
                data-testid="reset-request-form"
                noValidate
              >
                <FormRow label="Email" htmlFor="email">
                  <Input
                    id="email"
                    name="email"
                    type="email"
                    autoComplete="email"
                    autoFocus
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    disabled={submitting}
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
                  disabled={submitting || !email}
                  data-testid="reset-request-submit"
                >
                  {submitting ? "Sending…" : "Send reset link"}
                </Button>
              </form>
            )}
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
