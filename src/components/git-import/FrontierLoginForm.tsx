import { useEffect, useState } from "react"
import { useForm } from "@tanstack/react-form"
import { z } from "zod"
import { useNavigate } from "react-router-dom"
import { Button } from "@/components/ui/button"
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldError,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { RevealableInput } from "@/components/ui/revealable-input"
import { Spinner } from "@/components/ui/spinner"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { useT } from "@/lib/i18n/I18nProvider"
import { FrontierAuthError } from "@/lib/frontier/auth"
import { isFieldInvalid } from "@/lib/forms/field-state"
import { requiredString } from "@/lib/forms/schemas"
import { useSubmitError } from "@/lib/forms/submit-error"

const loginSchema = z.object({
  username: requiredString("Username or email"),
  password: requiredString("Password"),
})

export function FrontierLoginForm({
  onSuccess,
  onForgotPassword,
  returnTo,
}: {
  onSuccess: () => void
  onForgotPassword?: () => void
  /** If provided, navigate here after a successful login. */
  returnTo?: string
}) {
  const { login } = useFrontierSession()
  const t = useT()
  const navigate = useNavigate()
  const [isOnline, setIsOnline] = useState(() => navigator.onLine)
  const { submitError, setSubmitError, clearSubmitError } = useSubmitError()

  const form = useForm({
    defaultValues: { username: "", password: "" },
    validators: { onSubmit: loginSchema },
    onSubmit: async ({ value }) => {
      clearSubmitError()
      if (!isOnline) {
        setSubmitError("You're offline — connect to sign in")
        return
      }
      try {
        await login(value.username, value.password)
        onSuccess()
        if (returnTo) navigate(returnTo)
      } catch (err) {
        setSubmitError(err instanceof FrontierAuthError ? err.message : t("auth.login.failed"))
      }
    },
  })

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

  return (
    <form
      id="frontier-login-form"
      onSubmit={(e) => {
        e.preventDefault()
        void form.handleSubmit()
      }}
      className="flex flex-col gap-3"
    >
      {!isOnline && (
        <p className="rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
          You're offline — connect to sign in
        </p>
      )}
      <FieldGroup className="gap-3">
        <form.Field
          name="username"
          children={(field) => {
            const invalid = isFieldInvalid(field)
            return (
              <Field data-invalid={invalid}>
                <FieldLabel htmlFor="f-user">Aquilla username or email</FieldLabel>
                <Input
                  id="f-user"
                  name={field.name}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value)}
                  aria-invalid={invalid}
                  autoComplete="username"
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
                  <FieldLabel htmlFor="f-pass">Password</FieldLabel>
                  {onForgotPassword && (
                    <button
                      type="button"
                      onClick={onForgotPassword}
                      className="text-xs text-muted-foreground underline-offset-4 hover:underline"
                    >
                      Forgot password?
                    </button>
                  )}
                </div>
                <RevealableInput
                  id="f-pass"
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
      {submitError && (
        <p className="text-sm text-destructive">{submitError}</p>
      )}
      <Button type="submit" form="frontier-login-form" className="w-full">
        {form.state.isSubmitting && <Spinner data-icon="inline-start" />}
        {form.state.isSubmitting ? "Logging in…" : "Log in"}
      </Button>
    </form>
  )
}
