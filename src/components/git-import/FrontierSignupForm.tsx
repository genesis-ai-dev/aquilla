import { useEffect, useState } from "react"
import { useForm } from "@tanstack/react-form"
import { z } from "zod"
import { Button } from "@/components/ui/button"
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Check, X } from "lucide-react"
import { RevealableInput } from "@/components/ui/revealable-input"
import { Spinner } from "@/components/ui/spinner"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { FrontierAuthError } from "@/lib/frontier/auth"
import { isFieldInvalid } from "@/lib/forms/field-state"
import { useSubmitError } from "@/lib/forms/submit-error"

/** Pure function — exported for unit testing. */
export function checkPasswordRequirements(password: string, email: string) {
  const emailLocal = email.trim().toLowerCase().split("@")[0]
  return {
    minLength: password.length >= 8,
    notContainsEmail:
      emailLocal.length < 3
        ? true
        : !password.toLowerCase().includes(emailLocal),
  }
}

/** Weak/medium/strong heuristic — length + digit + symbol. */
export function passwordStrength(password: string): "weak" | "medium" | "strong" {
  if (password.length === 0) return "weak"
  let score = 0
  if (password.length >= 8) score++
  if (password.length >= 12) score++
  if (/[0-9]/.test(password)) score++
  if (/[^A-Za-z0-9]/.test(password)) score++
  if (score <= 1) return "weak"
  if (score === 2) return "medium"
  return "strong"
}

function PasswordChecklist({ password, email }: { password: string; email: string }) {
  const checks = checkPasswordRequirements(password, email)
  const strength = passwordStrength(password)
  const hasTyped = password.length > 0

  const strengthColor = {
    weak: "bg-destructive",
    medium: "bg-yellow-400",
    strong: "bg-green-500",
  }[strength]

  const strengthWidth = { weak: "w-1/3", medium: "w-2/3", strong: "w-full" }[strength]

  const items: { key: keyof typeof checks; label: string }[] = [
    { key: "minLength", label: "At least 8 characters" },
    { key: "notContainsEmail", label: "Does not contain your email" },
  ]

  return (
    <div className="mt-1.5 flex flex-col gap-1">
      {items.map(({ key, label }) => {
        const ok = checks[key]
        return (
          <div key={key} className="flex items-center gap-1.5 text-xs">
            {ok ? (
              <Check className="h-3 w-3 text-green-500 shrink-0" />
            ) : (
              <X className="h-3 w-3 text-muted-foreground shrink-0" />
            )}
            <span className={ok ? "text-green-600" : "text-muted-foreground"}>{label}</span>
          </div>
        )
      })}
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

const signupSchema = z
  .object({
    username: z
      .string()
      .trim()
      .min(3, "Username must be at least 3 characters")
      .max(50, "Username must be at most 50 characters"),
    email: z
      .string()
      .trim()
      .min(1, "Email is required")
      .email("Enter a valid email address"),
    password: z.string().min(1, "Password is required"),
  })
  .superRefine((data, ctx) => {
    const checks = checkPasswordRequirements(data.password, data.email)
    if (!checks.minLength) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Password must be at least 8 characters",
        path: ["password"],
      })
    }
    if (!checks.notContainsEmail) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Password must not contain your email",
        path: ["password"],
      })
    }
  })

export function FrontierSignupForm({ onSuccess }: { onSuccess: () => void }) {
  const { register } = useFrontierSession()
  const { submitError, setSubmitError, clearSubmitError } = useSubmitError()
  const [isOnline, setIsOnline] = useState(() => navigator.onLine)

  const form = useForm({
    defaultValues: { username: "", email: "", password: "" },
    validators: { onSubmit: signupSchema },
    onSubmit: async ({ value }) => {
      clearSubmitError()
      try {
        await register(value.username.trim(), value.email.trim(), value.password)
        onSuccess()
      } catch (err) {
        setSubmitError(err instanceof FrontierAuthError ? err.message : "Sign up failed")
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
      id="signup-form"
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
      <FieldGroup>
        <form.Field
          name="username"
          children={(field) => {
            const invalid = isFieldInvalid(field)
            return (
              <Field data-invalid={invalid}>
                <FieldLabel htmlFor="s-user">Username</FieldLabel>
                <Input
                  id="s-user"
                  name={field.name}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value)}
                  aria-invalid={invalid}
                  autoComplete="username"
                  maxLength={50}
                />
                {invalid && <FieldError errors={field.state.meta.errors} />}
              </Field>
            )
          }}
        />
        <form.Field
          name="email"
          children={(field) => {
            const invalid = isFieldInvalid(field)
            return (
              <Field data-invalid={invalid}>
                <FieldLabel htmlFor="s-email">Email</FieldLabel>
                <Input
                  id="s-email"
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
        <form.Subscribe
          selector={(state) => state.values.email}
          children={(email) => (
            <form.Field
              name="password"
              children={(field) => {
                const invalid = isFieldInvalid(field)
                return (
                  <Field data-invalid={invalid}>
                    <FieldLabel htmlFor="s-pass">Password</FieldLabel>
                    <RevealableInput
                      id="s-pass"
                      name={field.name}
                      value={field.state.value}
                      onBlur={field.handleBlur}
                      onChange={(e) => field.handleChange(e.target.value)}
                      aria-invalid={invalid}
                      autoComplete="new-password"
                    />
                    <PasswordChecklist password={field.state.value} email={email} />
                    {invalid && <FieldError errors={field.state.meta.errors} />}
                  </Field>
                )
              }}
            />
          )}
        />
      </FieldGroup>
      {submitError && <FieldError>{submitError}</FieldError>}
      <Button type="submit" form="signup-form" className="w-full">
        {form.state.isSubmitting && <Spinner data-icon="inline-start" />}
        {form.state.isSubmitting ? "Creating account…" : "Create account"}
      </Button>
    </form>
  )
}
