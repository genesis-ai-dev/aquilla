import { useForm } from "@tanstack/react-form"
import { z } from "zod"
import { Button } from "@/components/ui/button"
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  OptionalMark,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { createOrg, createOrgInvite } from "@/lib/frontier/orgs"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { useActiveOrg } from "@/context/OrgContext"
import { isFieldInvalid } from "@/lib/forms/field-state"
import { optionalString, requiredString } from "@/lib/forms/schemas"
import { useSubmitError } from "@/lib/forms/submit-error"
import posthog from "@/lib/posthog"
import { ORG_CREATED, INVITE_SENT } from "@/lib/event-names"

const formSchema = z.object({
  name: requiredString("Organization name"),
  emails: optionalString,
})

/**
 * Team-onboarding step: name the organization and (optionally) invite the first
 * collaborators by email in the same breath — embedding invitations into setup
 * is the single highest-signal predictor of team activation. Invites are
 * best-effort; a failed one never blocks org creation. On success the new org
 * becomes active so the following ProjectStep creates the first project inside
 * it.
 */
export function OrgStep({
  onCreated,
  onBack,
}: {
  onCreated: (orgId: number) => void
  onBack: () => void
}) {
  const { session } = useFrontierSession()
  const { refresh, setActiveOrg } = useActiveOrg()
  const { submitError, setSubmitError, clearSubmitError } = useSubmitError()

  const form = useForm({
    defaultValues: { name: "", emails: "" },
    validators: { onSubmit: formSchema },
    onSubmit: async ({ value }) => {
      clearSubmitError()
      if (!session?.jwt) {
        setSubmitError("Sign in to create an organization.")
        return
      }
      try {
        const org = await createOrg(session.jwt, value.name.trim())
        posthog.capture(ORG_CREATED, { org_id: org.id, source: "onboarding" })

        const list = value.emails
          .split(/[\s,]+/)
          .map((s) => s.trim())
          .filter((s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s))
        for (const email of list) {
          try {
            await createOrgInvite(session.jwt, org.id, { email })
            posthog.capture(INVITE_SENT, {
              scope: "org",
              org_id: org.id,
              has_email: true,
              source: "onboarding",
            })
          } catch {
            /* skip this invite; keep going */
          }
        }

        await refresh()
        setActiveOrg(org.id)
        onCreated(org.id)
      } catch (err) {
        setSubmitError(err instanceof Error ? err.message : "Couldn't create your organization.")
      }
    },
  })

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2 text-center">
        <h2 className="text-2xl font-semibold">Set up your organization</h2>
        <p className="text-sm text-muted-foreground">
          Give your team a home, and invite collaborators to get started together.
        </p>
      </div>
      <form
        id="org-step-form"
        autoComplete="off"
        onSubmit={(e) => {
          e.preventDefault()
          void form.handleSubmit()
        }}
        className="flex flex-col gap-4"
      >
        <FieldGroup>
          <form.Field
            name="name"
            children={(field) => {
              const invalid = isFieldInvalid(field)
              return (
                <Field data-invalid={invalid}>
                  <FieldLabel htmlFor="org-name">Organization name</FieldLabel>
                  <Input
                    id="org-name"
                    // Avoid DOM name="name" — Chrome contact autofill heuristic.
                    name="aquilla-org-name"
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    value={field.state.value}
                    onBlur={field.handleBlur}
                    onChange={(e) => field.handleChange(e.target.value)}
                    placeholder="Acme Bible Translation"
                    aria-invalid={invalid}
                    autoFocus
                  />
                  {invalid && <FieldError errors={field.state.meta.errors} />}
                </Field>
              )
            }}
          />
          <form.Field
            name="emails"
            children={(field) => (
              <Field>
                <FieldLabel htmlFor="org-emails">
                  Invite teammates <OptionalMark />
                </FieldLabel>
                <Input
                  id="org-emails"
                  name="aquilla-org-invite-emails"
                  type="text"
                  inputMode="email"
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value)}
                  placeholder="alex@example.com, sam@example.com"
                />
                <FieldDescription>
                  Comma- or space-separated emails. They'll get a link to join.
                </FieldDescription>
              </Field>
            )}
          />
        </FieldGroup>
        {submitError && (
          <FieldError role="alert">{submitError}</FieldError>
        )}
        <Button type="submit" form="org-step-form" size="lg" className="w-full">
          {form.state.isSubmitting && <Spinner data-icon="inline-start" />}
          {form.state.isSubmitting ? "Creating…" : "Create organization"}
        </Button>
      </form>
      <Button variant="ghost" onClick={onBack} className="w-full">
        ← Back
      </Button>
    </div>
  )
}
