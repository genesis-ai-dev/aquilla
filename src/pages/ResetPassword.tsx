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
import { useT } from "@/lib/i18n/I18nProvider"

// ---------------------------------------------------------------------------
// Inline password checklist (same logic as signup, but standalone here so the
// signup form module doesn't need to export its private component).
// ---------------------------------------------------------------------------
function PasswordChecklist({ password }: { password: string }) {
  const t = useT()
  const checks = checkPasswordRequirements(password, "")
  // `strength` is an English word (weak/medium/strong) from shared scoring
  // code — it is data, not UI copy, so only the "Strength:" label around it
  // is translated (see auth.resetPassword.checklistStrengthPrefix context).
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
          {t("auth.resetPassword.checklistMinLength")}
        </span>
      </div>
      {hasTyped && (
        <div className="mt-1 flex flex-col gap-0.5">
          <div className="h-1 w-full rounded bg-muted overflow-hidden">
            <div className={`h-full rounded transition-all ${strengthColor} ${strengthWidth}`} />
          </div>
          <p className="text-[10px] text-muted-foreground capitalize">
            {t("auth.resetPassword.checklistStrengthPrefix", { strength })}
          </p>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Recovery form — shown when the token is invalid/expired.
// ---------------------------------------------------------------------------
function TokenExpiredView({ username }: { username: string }) {
  const t = useT()
  const [sentEmail, setSentEmail] = useState<string | null>(null)
  const { submitError, setSubmitError, clearSubmitError } = useSubmitError()

  const emailSchema = z.object({
    email: z
      .string()
      .trim()
      .min(1, t("auth.resetPassword.emailRequired"))
      .email(t("auth.resetPassword.emailInvalid")),
  })

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
          err instanceof FrontierAuthError ? err.message : t("auth.resetPassword.failedToSend"),
        )
      }
    },
  })

  if (sentEmail) {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm">
          {t("auth.resetPassword.sentPrefix")}{" "}
          <span className="font-medium">{sentEmail}</span>. {t("auth.resetPassword.sentSuffix")}
        </p>
        <a
          href="/"
          className="inline-flex w-full items-center justify-center rounded-xl border px-3 py-1.5 text-sm font-medium transition-all hover:bg-muted"
        >
          {t("auth.resetPassword.backToApp")}
        </a>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-md bg-muted px-4 py-3 text-sm text-muted-foreground">
        {t("auth.resetPassword.expiredBody")}
        {username ? (
          <>
            {" "}
            {t("auth.resetPassword.expiredForAccount")}{" "}
            <span className="font-medium text-foreground">{username}</span>
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
                  <FieldLabel htmlFor="rp-email">{t("common.email")}</FieldLabel>
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
          {form.state.isSubmitting
            ? t("auth.resetPassword.sending")
            : t("auth.resetPassword.requestNewLink")}
        </Button>
        <a
          href="/"
          className="inline-flex w-full items-center justify-center text-sm text-muted-foreground hover:underline underline-offset-4"
        >
          {t("auth.resetPassword.backToApp")}
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
  const t = useT()
  const navigate = useNavigate()
  const { login } = useFrontierSession()
  const [searchParams] = useSearchParams()

  const token = searchParams.get("token") ?? ""
  const username = searchParams.get("username") ?? ""

  const [verifyState, setVerifyState] = useState<VerifyState>("loading")
  const { submitError, setSubmitError, clearSubmitError } = useSubmitError()

  const passwordSchema = z.object({
    password: z.string().min(8, t("auth.resetPassword.passwordTooShort")),
  })

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
          err instanceof FrontierAuthError ? err.message : t("auth.resetPassword.failedToReset"),
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
          <h1 className="text-2xl font-semibold">{t("auth.resetPassword.title")}</h1>
          {username && (
            <p className="text-sm text-muted-foreground">
              {t("auth.resetPassword.accountPrefix")}{" "}
              <span className="font-medium text-foreground">{username}</span>
            </p>
          )}
        </div>

        {verifyState === "loading" && (
          <p className="text-center text-sm text-muted-foreground">
            {t("auth.resetPassword.verifyingLink")}
          </p>
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
                      <FieldLabel htmlFor="rp-new-password">
                        {t("auth.resetPassword.newPasswordLabel")}
                      </FieldLabel>
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
              {form.state.isSubmitting
                ? t("auth.resetPassword.submitSetting")
                : t("auth.resetPassword.submitDefault")}
            </Button>
          </form>
        )}
      </div>
    </div>
  )
}
