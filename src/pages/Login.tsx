import { useForm } from "@tanstack/react-form"
import { z } from "zod"
import { useNavigate, useSearchParams } from "react-router-dom"
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
import { FrontierAuthError } from "@/lib/frontier/auth"
import { FrontierForgotPasswordForm } from "@/components/git-import/FrontierForgotPasswordForm"
import { isFieldInvalid } from "@/lib/forms/field-state"
import { requiredString } from "@/lib/forms/schemas"
import { useSubmitError } from "@/lib/forms/submit-error"
import { useState } from "react"
import { useT } from "@/lib/i18n/I18nProvider"

type Mode = "login" | "forgot"

// The messages requiredString() composes ("<label> is required") are built
// inside lib/forms/schemas.ts, which cannot call the t() hook (AQU-510,
// out of scope) — these labels stay English there even though the visible
// FieldLabels below are translated.
const loginSchema = z.object({
  username: requiredString("Username or email"),
  password: requiredString("Password"),
})

export function Login() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const { login } = useFrontierSession()
  const t = useT()

  const rawNext = searchParams.get("next") ?? ""
  const next = rawNext.startsWith("/") ? rawNext : "/"

  const [mode, setMode] = useState<Mode>("login")
  const [isMigrating, setIsMigrating] = useState(false)
  const { submitError, setSubmitError, clearSubmitError } = useSubmitError()

  const form = useForm({
    defaultValues: { username: "", password: "" },
    validators: { onSubmit: loginSchema },
    onSubmit: async ({ value }) => {
      clearSubmitError()
      setIsMigrating(false)
      try {
        await login(value.username, value.password, {
          onMigrationRequired: () => setIsMigrating(true),
        })
        navigate(next, { replace: true })
      } catch (err) {
        setSubmitError(err instanceof FrontierAuthError ? err.message : t("auth.login.failed"))
      }
    },
  })

  return (
    <div className="min-h-screen flex items-center justify-center p-8">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <h1 className="text-center text-2xl font-semibold">
          {mode === "login" ? t("auth.login.title") : t("auth.resetPassword.title")}
        </h1>

        {mode === "forgot" ? (
          <FrontierForgotPasswordForm onBack={() => setMode("login")} />
        ) : (
          <form
            id="login-form"
            onSubmit={(e) => {
              e.preventDefault()
              void form.handleSubmit()
            }}
            className="flex flex-col gap-4"
          >
            <FieldGroup>
              <form.Field
                name="username"
                children={(field) => {
                  const invalid = isFieldInvalid(field)
                  return (
                    <Field data-invalid={invalid}>
                      <FieldLabel htmlFor="login-user">{t("auth.login.usernameLabel")}</FieldLabel>
                      <Input
                        id="login-user"
                        name={field.name}
                        value={field.state.value}
                        onBlur={field.handleBlur}
                        onChange={(e) => field.handleChange(e.target.value)}
                        aria-invalid={invalid}
                        autoComplete="username"
                        autoFocus
                      />
                      {invalid && <FieldError errors={field.state.meta.errors} />}
                    </Field>
                  )
                }}
              />
              <form.Field
                name="password"
                children={(field) => {
                  const invalid = isFieldInvalid(field)
                  return (
                    <Field data-invalid={invalid}>
                      <div className="flex items-center justify-between">
                        <FieldLabel htmlFor="login-pass">{t("auth.login.passwordLabel")}</FieldLabel>
                        <button
                          type="button"
                          onClick={() => setMode("forgot")}
                          className="text-xs text-muted-foreground underline-offset-4 hover:underline"
                        >
                          {t("auth.login.forgotPasswordLink")}
                        </button>
                      </div>
                      <RevealableInput
                        id="login-pass"
                        name={field.name}
                        value={field.state.value}
                        onBlur={field.handleBlur}
                        onChange={(e) => field.handleChange(e.target.value)}
                        aria-invalid={invalid}
                        autoComplete="current-password"
                      />
                      {invalid && <FieldError errors={field.state.meta.errors} />}
                    </Field>
                  )
                }}
              />
            </FieldGroup>
            {submitError && <FieldError>{submitError}</FieldError>}
            <form.Subscribe
              selector={(state) => state.isSubmitting}
              children={(isSubmitting) => (
                <>
                  <Button
                    type="submit"
                    form="login-form"
                    className="w-full"
                    disabled={isSubmitting}
                    aria-describedby={
                      isSubmitting && isMigrating
                        ? "login-account-setup-note"
                        : undefined
                    }
                  >
                    {isSubmitting && (
                      <Spinner data-icon="inline-start" aria-hidden="true" />
                    )}
                    {isSubmitting
                      ? isMigrating
                        ? t("auth.login.submitMigrating")
                        : t("auth.login.submitSigningIn")
                      : t("auth.login.submitDefault")}
                  </Button>
                  {isSubmitting && isMigrating && (
                    <p
                      id="login-account-setup-note"
                      role="status"
                      aria-live="polite"
                      className="text-center text-xs text-muted-foreground"
                    >
                      {t("auth.login.migratingNote")}
                    </p>
                  )}
                </>
              )}
            />
          </form>
        )}

        {mode === "login" && (
          <p className="text-center text-sm text-muted-foreground">
            {t("auth.login.newHerePrefix")}{" "}
            <a
              href="/onboarding"
              className="font-medium text-foreground underline-offset-4 hover:underline"
            >
              {t("auth.login.createAccountLink")}
            </a>
          </p>
        )}
      </div>
    </div>
  )
}
