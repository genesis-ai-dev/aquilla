import { useEffect, useRef, useState } from "react"
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
import type { FrontierSession } from "@/lib/frontier/types"

// requiredString() composes "<label> is required" inside lib/forms/schemas.ts,
// which cannot call the t() hook (AQU-510, out of scope) — these labels stay
// English there even though the visible FieldLabels below are translated.
const loginSchema = z.object({
  username: requiredString("Username or email"),
  password: requiredString("Password"),
})

export function FrontierLoginForm({
  onSuccess,
  onForgotPassword,
  returnTo,
  initialUsername,
}: {
  onSuccess: (session: FrontierSession) => void | Promise<void>
  onForgotPassword?: () => void
  /** If provided, navigate here after a successful login. */
  returnTo?: string
  /**
   * AQU-1345: prefills the identifier field, e.g. when sign-up refused the
   * name and sent the reader here instead. Adopted the same way the sign-up
   * form adopts `initialEmail` — a later value lands, but never over an edit
   * the reader has already made.
   */
  initialUsername?: string | null
}) {
  const { login } = useFrontierSession()
  const t = useT()
  const navigate = useNavigate()
  const [isOnline, setIsOnline] = useState(() => navigator.onLine)
  const { submitError, setSubmitError, clearSubmitError } = useSubmitError()
  const usernameEditedRef = useRef(false)

  const form = useForm({
    defaultValues: { username: initialUsername ?? "", password: "" },
    validators: { onSubmit: loginSchema },
    onSubmit: async ({ value }) => {
      clearSubmitError()
      if (!isOnline) {
        setSubmitError(t("auth.login.offlineNotice"))
        return
      }
      try {
        const session = await login(value.username, value.password)
        await onSuccess(session)
        if (returnTo) navigate(returnTo)
      } catch (err) {
        setSubmitError(err instanceof FrontierAuthError ? err.message : t("auth.login.failed"))
      }
    },
  })

  useEffect(() => {
    if (!usernameEditedRef.current && initialUsername) {
      form.setFieldValue("username", initialUsername)
    }
  }, [form, initialUsername])

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
          {t("auth.login.offlineNotice")}
        </p>
      )}
      <FieldGroup className="gap-3">
        <form.Field
          name="username"
          children={(field) => {
            const invalid = isFieldInvalid(field)
            return (
              <Field data-invalid={invalid}>
                <FieldLabel htmlFor="f-user">{t("auth.login.aquillaUsernameLabel")}</FieldLabel>
                <Input
                  id="f-user"
                  name={field.name}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => {
                    usernameEditedRef.current = true
                    field.handleChange(e.target.value)
                  }}
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
                  <FieldLabel htmlFor="f-pass">{t("auth.login.passwordLabel")}</FieldLabel>
                  {onForgotPassword && (
                    <button
                      type="button"
                      onClick={onForgotPassword}
                      className="text-xs text-muted-foreground underline-offset-4 hover:underline"
                    >
                      {t("auth.login.forgotPasswordLink")}
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
        {form.state.isSubmitting ? t("auth.login.submitLoggingIn") : t("common.logIn")}
      </Button>
    </form>
  )
}
