import { useState } from "react"
import { useForm } from "@tanstack/react-form"
import { z } from "zod"
import { Button } from "@/components/ui/button"
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { requestPasswordReset, FrontierAuthError } from "@/lib/frontier/auth"
import { isFieldInvalid } from "@/lib/forms/field-state"
import { useSubmitError } from "@/lib/forms/submit-error"
import { useT } from "@/lib/i18n/I18nProvider"

const formSchema = z.object({
  email: z
    .string()
    .trim()
    .min(1, "Email is required")
    .email("Enter a valid email address"),
})

export function FrontierForgotPasswordForm({
  onBack,
  returnTo,
}: {
  onBack: (returnTo?: string) => void
  /** Forwarded back to the login form after returning from the reset flow. */
  returnTo?: string
}) {
  const [sentEmail, setSentEmail] = useState<string | null>(null)
  const { submitError, setSubmitError, clearSubmitError } = useSubmitError()
  const t = useT()

  const form = useForm({
    defaultValues: { email: "" },
    validators: { onSubmit: formSchema },
    onSubmit: async ({ value }) => {
      clearSubmitError()
      try {
        await requestPasswordReset(value.email.trim())
        setSentEmail(value.email.trim())
      } catch (err) {
        setSubmitError(err instanceof FrontierAuthError ? err.message : t("auth.resetPassword.failedToSend"))
      }
    },
  })

  if (sentEmail) {
    return (
      <div className="space-y-3">
        <p className="text-sm">
          If an account exists for <span className="font-medium">{sentEmail}</span>, a password reset link has been sent. Check your email and follow the link to choose a new password.
        </p>
        <Button variant="outline" onClick={() => onBack(returnTo)} className="w-full">
          Back to login
        </Button>
      </div>
    )
  }

  return (
    <form
      id="forgot-password-form"
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
                <FieldLabel htmlFor="r-email">Email</FieldLabel>
                <Input
                  id="r-email"
                  name={field.name}
                  type="email"
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value)}
                  aria-invalid={invalid}
                  autoComplete="email"
                />
                <FieldDescription>
                  We'll send a link to reset your password.
                </FieldDescription>
                {invalid && <FieldError errors={field.state.meta.errors} />}
              </Field>
            )
          }}
        />
      </FieldGroup>
      {submitError && <FieldError>{submitError}</FieldError>}
      <Button type="submit" form="forgot-password-form" className="w-full">
        {form.state.isSubmitting && <Spinner data-icon="inline-start" />}
        {form.state.isSubmitting ? "Sending…" : "Send reset link"}
      </Button>
      <Button type="button" variant="ghost" onClick={() => onBack(returnTo)} className="w-full">
        Back to login
      </Button>
    </form>
  )
}
