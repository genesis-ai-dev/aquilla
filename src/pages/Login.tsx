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

type Mode = "login" | "forgot"

const loginSchema = z.object({
  username: requiredString("Username or email"),
  password: requiredString("Password"),
})

export function Login() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const { login } = useFrontierSession()

  const rawNext = searchParams.get("next") ?? ""
  const next = rawNext.startsWith("/") ? rawNext : "/"

  const [mode, setMode] = useState<Mode>("login")
  const { submitError, setSubmitError, clearSubmitError } = useSubmitError()

  const form = useForm({
    defaultValues: { username: "", password: "" },
    validators: { onSubmit: loginSchema },
    onSubmit: async ({ value }) => {
      clearSubmitError()
      try {
        await login(value.username, value.password)
        navigate(next, { replace: true })
      } catch (err) {
        setSubmitError(err instanceof FrontierAuthError ? err.message : "Login failed")
      }
    },
  })

  return (
    <div className="min-h-screen flex items-center justify-center p-8">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <h1 className="text-center text-2xl font-semibold">
          {mode === "login" ? "Sign in" : "Reset your password"}
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
                      <FieldLabel htmlFor="login-user">Username or email</FieldLabel>
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
                        <FieldLabel htmlFor="login-pass">Password</FieldLabel>
                        <button
                          type="button"
                          onClick={() => setMode("forgot")}
                          className="text-xs text-muted-foreground underline-offset-4 hover:underline"
                        >
                          Forgot password?
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
                      isSubmitting ? "login-account-setup-note" : undefined
                    }
                  >
                    {isSubmitting && (
                      <Spinner data-icon="inline-start" aria-hidden="true" />
                    )}
                    {isSubmitting
                      ? "Setting up your account and permissions…"
                      : "Sign in"}
                  </Button>
                  {isSubmitting && (
                    <p
                      id="login-account-setup-note"
                      role="status"
                      aria-live="polite"
                      className="text-center text-xs text-muted-foreground"
                    >
                      First-time sign-in may take a moment while we securely
                      migrate your account.
                    </p>
                  )}
                </>
              )}
            />
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
