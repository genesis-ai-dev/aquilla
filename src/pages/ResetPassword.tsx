/**
 * AQU-270: /reset-password page
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

import { useState, useEffect } from "react"
import { useForm } from "@tanstack/react-form"
import { z } from "zod"
import { useNavigate, useSearchParams } from "react-router-dom"
import { Check, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { RevealableInput } from "@/components/ui/revealable-input"
import { Spinner } from "@/components/ui/spinner"
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
import { isFieldInvalid } from "@/lib/forms/field-state"
import { useSubmitError } from "@/lib/forms/submit-error"

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
    <div className="mt-1.5 flex flex-col gap-1">
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
        <div className="mt-1 flex flex-col gap-0.5">
          <div className="h-1 w-full rounded bg-muted overflow-hidden">
            <div className={`h-full rounded transition-all ${strengthColor} ${strengthWidth}`} />
          </div>
          <p className="text-[10px] text-muted-foreground capitalize">Strength: {strength}</p>
        </div>
      )}
    </div>
  )
}

const emailSchema = z.object({
  email: z
    .string()
    .trim()
    .min(1, "Email is required")
    .email("Enter a valid email address"),
})

const passwordSchema = z.object({
  password: z.string().min(8, "Password must be at least 8 characters"),
})

// ---------------------------------------------------------------------------
// Recovery form — shown when the token is invalid/expired.
// ---------------------------------------------------------------------------
function TokenExpiredView({ username }: { username: string }) {
  const [sentEmail, setSentEmail] = useState<string | null>(null)
  const { submitError, setSubmitError, clearSubmitError } = useSubmitError()

  const form = useForm({
    defaultValues: { email: "" },
    validators: { onSubmit: emailSchema },
    onSubmit: async ({ value }) => {
      clearSubmitError()
      try {
        await requestPasswordReset(value.email.trim())
        setSentEmail(value.email.trim())
      } catch (err) {
        setSubmitError(
          err instanceof FrontierAuthError ? err.message : "Failed to send reset email",
        )
      }
    },
  })

  if (sentEmail) {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm">
          A new reset link has been sent to{" "}
          <span className="font-medium">{sentEmail}</span>. Check your inbox and
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
    <div className="flex flex-col gap-4">
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
      <form
        id="token-expired-form"
        onSubmit={(e) => {
          e.preventDefault()
          void form.handleSubmit()
        }}
        className="flex flex-col gap-3"
      >
        <FieldGroup>
          <form.Field
            name="email"
            children={(field) => {
              const invalid = isFieldInvalid(field)
              return (
                <Field data-invalid={invalid}>
                  <FieldLabel htmlFor="rp-email">Email</FieldLabel>
                  <Input
                    id="rp-email"
                    name={field.name}
                    type="email"
                    value={field.state.value}
                    onBlur={field.handleBlur}
                    onChange={(e) => field.handleChange(e.target.value)}
                    aria-invalid={invalid}
                    autoComplete="email"
                  />
                  {invalid && <FieldError errors={field.state.meta.errors} />}
                </Field>
              )
            }}
          />
        </FieldGroup>
        {submitError && <FieldError>{submitError}</FieldError>}
        <Button type="submit" form="token-expired-form" className="w-full">
          {form.state.isSubmitting && <Spinner data-icon="inline-start" />}
          {form.state.isSubmitting ? "Sending…" : "Request a new link"}
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
  const { submitError, setSubmitError, clearSubmitError } = useSubmitError()

  const form = useForm({
    defaultValues: { password: "" },
    validators: { onSubmit: passwordSchema },
    onSubmit: async ({ value }) => {
      clearSubmitError()
      try {
        await resetPassword(token, username, value.password)
        await login(username, value.password)
        navigate("/", { replace: true })
      } catch (err) {
        setSubmitError(
          err instanceof FrontierAuthError ? err.message : "Failed to reset password",
        )
      }
    },
  })

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

  return (
    <div className="min-h-screen flex items-center justify-center p-8">
      <div className="w-full max-w-sm flex flex-col gap-6">
        <div className="flex flex-col gap-1 text-center">
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
          <form
            id="reset-password-form"
            onSubmit={(e) => {
              e.preventDefault()
              void form.handleSubmit()
            }}
            className="flex flex-col gap-4"
          >
            <FieldGroup>
              <form.Field
                name="password"
                children={(field) => {
                  const invalid = isFieldInvalid(field)
                  return (
                    <Field data-invalid={invalid}>
                      <FieldLabel htmlFor="rp-new-password">New password</FieldLabel>
                      <RevealableInput
                        id="rp-new-password"
                        name={field.name}
                        value={field.state.value}
                        onBlur={field.handleBlur}
                        onChange={(e) => field.handleChange(e.target.value)}
                        aria-invalid={invalid}
                        autoComplete="new-password"
                        autoFocus
                      />
                      <PasswordChecklist password={field.state.value} />
                      {invalid && <FieldError errors={field.state.meta.errors} />}
                    </Field>
                  )
                }}
              />
            </FieldGroup>
            {submitError && <FieldError>{submitError}</FieldError>}
            <Button type="submit" form="reset-password-form" className="w-full">
              {form.state.isSubmitting && <Spinner data-icon="inline-start" />}
              {form.state.isSubmitting ? "Setting password…" : "Set new password"}
            </Button>
          </form>
        )}
      </div>
    </div>
  )
}
